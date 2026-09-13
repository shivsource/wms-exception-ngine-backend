import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { PredictionEvaluationResult, RiskPredictor, RiskSignal } from '../interfaces';
import { computePendingDemandBySku, InventoryPosition, summarizeInventoryBySku } from '../queries';
import { CanonicalProduct } from '../canonical/types';
import { EntityType, PredictionType } from '../types/enums';
import { activeResult, insufficientData } from './shared';

const EMPTY_POSITION = (sku: string): InventoryPosition => ({ sku, totalQuantity: 0, totalReserved: 0, totalDamaged: 0, totalAvailable: 0 });

/**
 * Predicts whether a SKU is likely to run short of stock before picking fails — the leading
 * indicator for ExceptionType.INVENTORY_SHORTAGE. Unlike the existing detection rule (which
 * only compares total available stock to the reorder level), this predictor also weighs
 * still-unpicked demand from currently-open orders against available stock — the "required
 * vs. available vs. reserved-for-others" relationship. Scoped to active products with a
 * reorder level configured, same as InventoryShortageRule (a null reorder level can never
 * be assessed — see CANONICAL_MODEL.md).
 *
 * No time dimension exists in the schema for inventory replenishment (no lead-time/ETA
 * field), so predictionWindow is always null here — see the `limitations` note on each result.
 */
export class InventoryShortagePredictor implements RiskPredictor {
  readonly name = 'InventoryShortagePredictor';
  readonly predictionType = PredictionType.INVENTORY_SHORTAGE_RISK;
  readonly entityType = EntityType.PRODUCT;

  async evaluateAll(): Promise<PredictionEvaluationResult[]> {
    const [inventory, products, orders] = await Promise.all([
      logisticsDataSource.getInventory(),
      logisticsDataSource.getProducts(),
      logisticsDataSource.getOrders(),
    ]);
    const positions = summarizeInventoryBySku(inventory);
    const pendingBySku = computePendingDemandBySku(orders);

    return products
      .filter((p) => p.active && p.reorderLevel !== null)
      .map((product) => this.evaluateProduct(product, positions.get(product.sku) ?? EMPTY_POSITION(product.sku), pendingBySku.get(product.sku) ?? 0));
  }

  async evaluateOne(entityId: string): Promise<PredictionEvaluationResult> {
    const product = await logisticsDataSource.getProductBySku(entityId);
    if (!product) {
      return insufficientData(this.predictionType, this.entityType, entityId, [`Product ${entityId} could not be found in the source system.`]);
    }
    if (!product.active) {
      return insufficientData(this.predictionType, this.entityType, entityId, [`Product ${entityId} is inactive — shortage risk is not assessed for inactive products.`]);
    }
    if (product.reorderLevel === null) {
      return insufficientData(this.predictionType, this.entityType, entityId, [`Product ${entityId} has no reorder level configured, so shortage risk cannot be assessed.`]);
    }

    const [inventory, orders] = await Promise.all([logisticsDataSource.getInventory({ sku: entityId }), logisticsDataSource.getOrders()]);
    const position = summarizeInventoryBySku(inventory).get(entityId) ?? EMPTY_POSITION(entityId);
    const pendingDemand = computePendingDemandBySku(orders).get(entityId) ?? 0;
    return this.evaluateProduct(product, position, pendingDemand);
  }

  private evaluateProduct(product: CanonicalProduct, position: InventoryPosition, pendingDemand: number): PredictionEvaluationResult {
    const { weights } = thresholds.prediction.inventoryShortage;
    const reorderLevel = product.reorderLevel as number;
    const signals: RiskSignal[] = [];

    const shortfall = pendingDemand - position.totalAvailable;
    const shortfallRatio = pendingDemand > 0 ? Math.min(1, Math.max(0, shortfall) / pendingDemand) : 0;
    signals.push({
      signal: 'PENDING_DEMAND_SHORTFALL',
      value: pendingDemand,
      expected: position.totalAvailable,
      unit: 'UNITS',
      contribution: Math.round(weights.pendingDemandShortfall * shortfallRatio),
      reason:
        shortfall > 0
          ? `Open orders still require ${pendingDemand} unpicked units of ${product.sku}, but only ${position.totalAvailable} are currently available (shortfall of ${shortfall}).`
          : `Open-order demand (${pendingDemand} units) does not currently exceed available stock (${position.totalAvailable} units).`,
    });

    const proximityRatio = reorderLevel > 0 ? Math.min(1, Math.max(0, reorderLevel - position.totalAvailable) / reorderLevel) : 0;
    signals.push({
      signal: 'REORDER_PROXIMITY',
      value: position.totalAvailable,
      expected: reorderLevel,
      unit: 'UNITS',
      contribution: Math.round(weights.reorderProximity * proximityRatio),
      reason: `Available stock (${position.totalAvailable}) compared against the reorder level (${reorderLevel}) for "${product.name}".`,
    });

    const damagedRatio = position.totalQuantity > 0 ? Math.min(1, position.totalDamaged / position.totalQuantity) : 0;
    signals.push({
      signal: 'DAMAGED_INVENTORY_EXPOSURE',
      value: position.totalDamaged,
      expected: position.totalQuantity,
      unit: 'UNITS',
      contribution: Math.round(weights.damagedExposure * damagedRatio),
      reason:
        position.totalDamaged > 0
          ? `${position.totalDamaged} of ${position.totalQuantity} physical units of ${product.sku} are recorded as damaged.`
          : 'No damaged inventory recorded for this SKU.',
    });

    return activeResult({
      predictionType: this.predictionType,
      entityType: this.entityType,
      entityId: product.sku,
      signals,
      confidence: 'HIGH',
      predictionWindow: null,
      explanation: `SKU ${product.sku} ("${product.name}") has ${position.totalAvailable} units available against ${pendingDemand} units of open-order demand and a reorder level of ${reorderLevel}.`,
      limitations: ['No replenishment lead-time/ETA data is available in the source system, so no time-bound prediction window applies to this risk type.'],
    });
  }
}
