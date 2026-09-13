import { thresholds } from '../config/thresholds';
import { CauseConfidence, CauseOrigin, PersistedException, SupportingEvidenceItem } from '../interfaces';

/**
 * Working shape a candidate-scoring function builds up before it's known whether the
 * candidate will survive (score > 0). Kept internal to src/root-cause/ — it's a scoring
 * intermediate, not part of the public RootCauseAnalysis contract.
 */
export interface CandidateResult {
  type: string;
  category: CauseOrigin;
  score: number;
  evidence: SupportingEvidenceItem[];
  explanationParts: string[];
}

/** A candidate that found no supporting evidence at all — dropped before ranking, never reported. */
export function emptyCandidate(type: string, category: CauseOrigin): CandidateResult {
  return { type, category, score: 0, evidence: [], explanationParts: [] };
}

/**
 * Converts a candidate's additive score into a confidence band. No single scoring rule
 * in config/thresholds.ts is worth `high` on its own, so reaching HIGH requires at least
 * two independent corroborating facts — see the comment on `thresholds.rootCause`.
 */
export function scoreToConfidence(score: number): CauseConfidence {
  const { high, medium } = thresholds.rootCause.confidenceScore;
  if (score >= high) return 'HIGH';
  if (score >= medium) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'INSUFFICIENT_EVIDENCE';
}

/** Dedupes a type-filtered, most-recent-first exception list down to one row per entityId. */
export function latestByEntityId(exceptions: PersistedException[]): Map<string, PersistedException> {
  const latest = new Map<string, PersistedException>();
  for (const exception of exceptions) {
    if (!latest.has(exception.entityId)) latest.set(exception.entityId, exception);
  }
  return latest;
}

export interface SkuLocationEntry {
  sku: string;
  location: string;
}

export interface DiscrepancyMatch {
  entry: SkuLocationEntry;
  exception: PersistedException;
  exact: boolean;
}

/**
 * Matches sku+location entries (picking-delay's pending items, picking-error's error
 * items, etc.) against INVENTORY_DISCREPANCY exceptions (entityId `${sku}:${location}`),
 * preferring an exact sku+location match over a sku-only match at a different location.
 * Shared by every analyzer that needs this correlation instead of each re-implementing it.
 */
export function matchInventoryDiscrepancies(
  entries: SkuLocationEntry[],
  discrepancies: PersistedException[],
): DiscrepancyMatch[] {
  const matches: DiscrepancyMatch[] = [];
  for (const entry of entries) {
    const exact = discrepancies.find((d) => d.entityId === `${entry.sku}:${entry.location}`);
    if (exact) {
      matches.push({ entry, exception: exact, exact: true });
      continue;
    }
    const skuOnly = discrepancies.find((d) => d.entityId.split(':')[0] === entry.sku);
    if (skuOnly) matches.push({ entry, exception: skuOnly, exact: false });
  }
  return matches;
}
