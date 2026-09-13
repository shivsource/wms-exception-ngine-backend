import { thresholds } from '../config/thresholds';
import {
  CausalChainLink,
  InventoryShortageEvidence,
  PersistedException,
  RootCause,
  RootCauseAnalysis,
  RootCauseAnalyzer,
} from '../interfaces';
import { exceptionRepository } from '../repositories';
import { ExceptionSeverity, ExceptionType } from '../types/enums';
import { CandidateResult, emptyCandidate, matchInventoryDiscrepancies, scoreToConfidence } from './shared';

const HIGH_SEVERITIES: ExceptionSeverity[] = [ExceptionSeverity.HIGH, ExceptionSeverity.CRITICAL];

export class InventoryShortageAnalyzer implements RootCauseAnalyzer {
  readonly exceptionType = ExceptionType.INVENTORY_SHORTAGE;

  async analyze(exception: PersistedException, evidenceRaw: Record<string, unknown>): Promise<RootCauseAnalysis> {
    const evidence = evidenceRaw as unknown as InventoryShortageEvidence;

    const discrepancy = await this.scoreInventoryDiscrepancy(evidence);
    const overAllocation = this.scoreReservationOverAllocation(evidence);
    const damaged = this.scoreDamagedInventory(evidence);
    const depletion = this.scoreStockDepletion(evidence, overAllocation.score > 0, damaged.score > 0);

    // Fixed declaration order keeps tie-breaking deterministic: specific, directly-evidenced
    // anomalies are checked before the residual "no alternative explanation" depletion cause.
    const candidates = [overAllocation, damaged, discrepancy, depletion].filter((candidate) => candidate.score > 0);
    candidates.sort((a, b) => b.score - a.score);

    const causes: RootCause[] = candidates.map((candidate) => ({
      type: candidate.type,
      category: candidate.category,
      score: candidate.score,
      confidenceLevel: scoreToConfidence(candidate.score),
      explanation: candidate.explanationParts.join(' '),
    }));

    const primaryCause = causes[0] ?? null;
    const contributingCauses = causes.slice(1);
    const supportingEvidence = candidates.flatMap((candidate) => candidate.evidence);

    const causalChain: CausalChainLink[] = causes
      .filter((cause) => cause.category === 'OBSERVED')
      .map((cause) => ({
        from: cause.type,
        to: exception.type,
        relationship: `Correlated with SKU ${evidence.product.sku} (${exception.exceptionId}).`,
      }));

    const limitations: string[] = [];
    if (depletion.score > 0) {
      limitations.push(
        'Stock depletion is confirmed by the available-quantity numbers, but this schema has no order-velocity or replenishment-lead-time data, so whether it is driven by demand, slow replenishment, or something else cannot be determined.',
      );
    }
    if (!primaryCause) {
      limitations.push(
        'No location-level anomaly (over-reservation, damage), correlated inventory discrepancy, or shortfall large enough to call confirmed depletion was found. The shortage may be due to a cause not yet modeled by this engine.',
      );
    }

    const analysisExplanation = primaryCause
      ? `The most likely cause of this inventory shortage is ${primaryCause.type} ` +
        `(${primaryCause.category.toLowerCase()}, confidence ${primaryCause.confidenceLevel}, score ${primaryCause.score}/100).` +
        (contributingCauses.length > 0
          ? ` ${contributingCauses.length} other contributing factor(s) were also identified: ${contributingCauses.map((c) => c.type).join(', ')}.`
          : '')
      : 'No supported root cause could be identified for this inventory shortage from currently available evidence.';

    return {
      exceptionId: exception.exceptionId,
      exceptionType: exception.type,
      primaryCause,
      contributingCauses,
      supportingEvidence,
      causalChain,
      limitations,
      analysisExplanation,
      analyzedAt: new Date(),
    };
  }

  /** OBSERVED: a location where reserved quantity exceeds physical quantity — a direct data fact. */
  private scoreReservationOverAllocation(evidence: InventoryShortageEvidence): CandidateResult {
    const w = thresholds.rootCause.inventoryShortage.weights.reservationOverAllocation;
    const overReserved = evidence.locations.filter((loc) => loc.reservedQuantity > loc.quantity);
    if (overReserved.length === 0) return emptyCandidate('RESERVATION_OVER_ALLOCATION', 'OBSERVED');

    let score = w.anyLocation;
    const evidenceItems: CandidateResult['evidence'] = [
      {
        field: `locations.${overReserved[0].location}.reservedQuantity`,
        value: overReserved[0].reservedQuantity,
        weight: w.anyLocation,
        supports: 'RESERVATION_OVER_ALLOCATION',
      },
    ];
    const parts = [
      `At location ${overReserved[0].location}, reserved quantity (${overReserved[0].reservedQuantity}) exceeds physical quantity (${overReserved[0].quantity}).`,
    ];

    // Compared against how negative totalAvailable actually is, not shortfallUnits — shortfallUnits
    // includes the healthy reorder-level buffer too, which over-reservation doesn't "explain".
    const overReservedUnits = overReserved.reduce((sum, loc) => sum + (loc.reservedQuantity - loc.quantity), 0);
    const negativeAvailability = Math.max(0, -evidence.totals.totalAvailable);
    const { explanationCoverageRatio } = thresholds.rootCause.inventoryShortage;
    if (negativeAvailability > 0 && overReservedUnits >= negativeAvailability * explanationCoverageRatio) {
      score += w.explainsShortfall;
      parts.push(`Over-reservation accounts for ${overReservedUnits} of the ${negativeAvailability}-unit availability deficit.`);
      evidenceItems.push({
        field: 'totals.overReservedUnits',
        value: overReservedUnits,
        weight: w.explainsShortfall,
        supports: 'RESERVATION_OVER_ALLOCATION',
      });
    }

    if (overReserved.length > 1) {
      score += w.multipleLocations;
      parts.push(`${overReserved.length} locations show reserved quantity exceeding physical quantity.`);
      evidenceItems.push({
        field: 'locations.overReservedCount',
        value: overReserved.length,
        weight: w.multipleLocations,
        supports: 'RESERVATION_OVER_ALLOCATION',
      });
    }

    return {
      type: 'RESERVATION_OVER_ALLOCATION',
      category: 'OBSERVED',
      score,
      evidence: evidenceItems,
      explanationParts: parts,
    };
  }

  /** OBSERVED: damaged units across this product's locations covering a meaningful share of the shortfall. */
  private scoreDamagedInventory(evidence: InventoryShortageEvidence): CandidateResult {
    const w = thresholds.rootCause.inventoryShortage.weights.damagedInventory;
    const { explanationCoverageRatio } = thresholds.rootCause.inventoryShortage;
    const totalDamaged = evidence.locations.reduce((sum, loc) => sum + loc.damagedQuantity, 0);
    const shortfall = evidence.totals.shortfallUnits;
    if (totalDamaged === 0 || shortfall <= 0 || totalDamaged < shortfall * explanationCoverageRatio) {
      return emptyCandidate('DAMAGED_INVENTORY', 'OBSERVED');
    }

    let score = w.explainsShortfall;
    const evidenceItems: CandidateResult['evidence'] = [
      { field: 'totals.damagedQuantity', value: totalDamaged, weight: w.explainsShortfall, supports: 'DAMAGED_INVENTORY' },
    ];
    const parts = [
      `${totalDamaged} damaged units across this product's stock account for a meaningful share of the ${shortfall}-unit shortfall.`,
    ];

    if (totalDamaged >= shortfall) {
      score += w.fullyExplains;
      parts.push('Damaged inventory alone is enough to fully account for the shortfall.');
      evidenceItems.push({
        field: 'totals.damagedQuantity',
        value: totalDamaged,
        weight: w.fullyExplains,
        supports: 'DAMAGED_INVENTORY',
      });
    }

    const damagedLocations = evidence.locations.filter((loc) => loc.damagedQuantity > 0);
    if (damagedLocations.length > 1) {
      score += w.multipleLocations;
      parts.push(`Damage is recorded across ${damagedLocations.length} locations.`);
      evidenceItems.push({
        field: 'locations.damagedLocationCount',
        value: damagedLocations.length,
        weight: w.multipleLocations,
        supports: 'DAMAGED_INVENTORY',
      });
    }

    return { type: 'DAMAGED_INVENTORY', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** OBSERVED: the residual explanation — a large shortfall with no location-level anomaly explaining it. */
  private scoreStockDepletion(
    evidence: InventoryShortageEvidence,
    hasOverReservation: boolean,
    hasSignificantDamage: boolean,
  ): CandidateResult {
    const w = thresholds.rootCause.inventoryShortage.weights.stockDepletion;
    const t = thresholds.inventoryShortage;
    const ratio = evidence.totals.shortfallPercentage / 100;

    const ratioScore = ratio >= t.critical ? w.criticalRatio : ratio >= t.high ? w.highRatio : ratio >= t.medium ? w.mediumRatio : 0;
    if (ratioScore === 0) return emptyCandidate('STOCK_DEPLETION', 'OBSERVED');

    let score = ratioScore;
    const evidenceItems: CandidateResult['evidence'] = [
      {
        field: 'totals.shortfallPercentage',
        value: evidence.totals.shortfallPercentage,
        weight: ratioScore,
        supports: 'STOCK_DEPLETION',
      },
    ];
    const parts = [`Available stock is ${evidence.totals.shortfallPercentage}% below the reorder level.`];

    if (evidence.totals.totalAvailable <= 0) {
      score += w.zeroAvailable;
      parts.push('Total available stock across all locations is zero or negative.');
      evidenceItems.push({
        field: 'totals.totalAvailable',
        value: evidence.totals.totalAvailable,
        weight: w.zeroAvailable,
        supports: 'STOCK_DEPLETION',
      });
    }

    if (!hasOverReservation && !hasSignificantDamage) {
      score += w.noOtherExplanation;
      parts.push('No over-reservation or significant damage explains the shortfall — this looks like genuine stock depletion.');
      evidenceItems.push({
        field: 'diagnosis.noAlternativeExplanation',
        value: true,
        weight: w.noOtherExplanation,
        supports: 'STOCK_DEPLETION',
      });
    }

    return { type: 'STOCK_DEPLETION', category: 'OBSERVED', score, evidence: evidenceItems, explanationParts: parts };
  }

  /** OBSERVED: correlate this product's actual stock locations against INVENTORY_DISCREPANCY exceptions. */
  private async scoreInventoryDiscrepancy(evidence: InventoryShortageEvidence): Promise<CandidateResult> {
    const w = thresholds.rootCause.inventoryShortage.weights.inventoryDiscrepancy;
    if (evidence.locations.length === 0) return emptyCandidate('INVENTORY_DISCREPANCY', 'OBSERVED');

    const entries = evidence.locations.map((loc) => ({ sku: evidence.product.sku, location: loc.location }));
    const discrepancies = await exceptionRepository.findAllByType(ExceptionType.INVENTORY_DISCREPANCY);
    const matches = matchInventoryDiscrepancies(entries, discrepancies);
    if (matches.length === 0) return emptyCandidate('INVENTORY_DISCREPANCY', 'OBSERVED');

    let score = 0;
    const evidenceItems: CandidateResult['evidence'] = [];
    const parts: string[] = [];

    const exactMatch = matches.find((m) => m.exact);
    if (exactMatch) {
      score += w.exactMatch;
      parts.push(
        `Inventory discrepancy recorded at ${exactMatch.entry.location} (${exactMatch.exception.exceptionId}) — one of this product's actual stock locations.`,
      );
      evidenceItems.push({
        field: `inventoryDiscrepancy.${exactMatch.exception.entityId}`,
        value: exactMatch.exception.status,
        weight: w.exactMatch,
        supports: 'INVENTORY_DISCREPANCY',
      });
    } else {
      const { entry, exception: exc } = matches[0];
      score += w.skuOnlyMatch;
      parts.push(`Inventory discrepancy recorded for SKU ${entry.sku} at ${exc.entityId}.`);
      evidenceItems.push({
        field: `inventoryDiscrepancy.${exc.entityId}`,
        value: exc.status,
        weight: w.skuOnlyMatch,
        supports: 'INVENTORY_DISCREPANCY',
      });
    }

    if (matches.length > 1) {
      score += w.multipleLocations;
      parts.push(`${matches.length} of this product's stock locations are affected by inventory discrepancies.`);
      evidenceItems.push({
        field: 'inventoryDiscrepancy.affectedLocationCount',
        value: matches.length,
        weight: w.multipleLocations,
        supports: 'INVENTORY_DISCREPANCY',
      });
    }

    if (matches.some(({ exception: exc }) => HIGH_SEVERITIES.includes(exc.severity))) {
      score += w.highSeverity;
      parts.push('The matched discrepancy is rated HIGH or CRITICAL.');
      evidenceItems.push({
        field: 'inventoryDiscrepancy.severity',
        value: 'HIGH_OR_CRITICAL',
        weight: w.highSeverity,
        supports: 'INVENTORY_DISCREPANCY',
      });
    }

    return {
      type: 'INVENTORY_DISCREPANCY',
      category: 'OBSERVED',
      score,
      evidence: evidenceItems,
      explanationParts: parts,
    };
  }
}
