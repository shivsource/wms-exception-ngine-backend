import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { PredictionEvaluationResult, RiskPredictor, RiskSignal } from '../interfaces';
import { findOrdersAtRiskOfSlaBreach, groupTasksByOrderId, isOrderFullyPicked } from '../queries';
import { CanonicalOrder, CanonicalPickingTask } from '../canonical/types';
import { EntityType, PredictionType } from '../types/enums';
import { minutesBetween } from '../utils/dateTime';
import { activeResult, insufficientData, urgencyRatio } from './shared';

/**
 * Predicts whether an order not yet dispatched is likely to breach its dispatch SLA — the
 * leading indicator for ExceptionType.SLA_AT_RISK (see shared.ts's PREDICTS_EXCEPTION_TYPE).
 * Signals are derived only from CanonicalOrder/CanonicalPickingTask/CanonicalPacking fields
 * that already exist — see CANONICAL_MODEL.md. No field is invented.
 */
export class SlaBreachPredictor implements RiskPredictor {
  readonly name = 'SlaBreachPredictor';
  readonly predictionType = PredictionType.SLA_BREACH_RISK;
  readonly entityType = EntityType.ORDER;

  async evaluateAll(): Promise<PredictionEvaluationResult[]> {
    const now = new Date();
    const { windowMinutes } = thresholds.prediction.slaBreach;
    const [allOrders, allTasks, allPacking] = await Promise.all([
      logisticsDataSource.getOrders({ excludeStatus: ['DISPATCHED', 'CANCELLED'] }),
      logisticsDataSource.getPickingTasks(),
      logisticsDataSource.getPacking(),
    ]);
    const candidates = findOrdersAtRiskOfSlaBreach(allOrders, windowMinutes, now);
    const tasksByOrderId = groupTasksByOrderId(allTasks);
    const packedOrderIds = new Set(allPacking.map((p) => p.orderId));

    return candidates.map((order) => this.evaluateOrder(order, tasksByOrderId, packedOrderIds, now));
  }

  async evaluateOne(entityId: string): Promise<PredictionEvaluationResult> {
    const order = await logisticsDataSource.getOrderById(entityId);
    if (!order) {
      return insufficientData(this.predictionType, this.entityType, entityId, [
        `Order ${entityId} could not be found in the source system.`,
      ]);
    }
    if (order.status === null) {
      return insufficientData(this.predictionType, this.entityType, entityId, [
        `Order ${entityId} has no recorded status, so its fulfillment stage cannot be assessed.`,
      ]);
    }
    if (order.status === 'DISPATCHED' || order.status === 'CANCELLED') {
      return insufficientData(this.predictionType, this.entityType, entityId, [
        `Order ${entityId} is already ${order.status} — SLA breach risk is no longer applicable.`,
      ]);
    }

    const now = new Date();
    const [allTasks, allPacking] = await Promise.all([logisticsDataSource.getPickingTasks(), logisticsDataSource.getPacking()]);
    return this.evaluateOrder(order, groupTasksByOrderId(allTasks), new Set(allPacking.map((p) => p.orderId)), now);
  }

  private evaluateOrder(
    order: CanonicalOrder,
    tasksByOrderId: Map<string, CanonicalPickingTask[]>,
    packedOrderIds: Set<string>,
    now: Date,
  ): PredictionEvaluationResult {
    const { windowMinutes, weights } = thresholds.prediction.slaBreach;
    const minutesRemaining = minutesBetween(now, order.expectedDispatchTime);
    const tasks = tasksByOrderId.get(order.orderId) ?? [];
    const pickingComplete = isOrderFullyPicked(tasks);
    const packingRecorded = packedOrderIds.has(order.orderId);
    const pendingItems = order.items.reduce((sum, item) => sum + Math.max(0, item.orderedQuantity - (item.pickedQuantity ?? 0)), 0);

    const signals: RiskSignal[] = [];

    const urgency = urgencyRatio(minutesRemaining, windowMinutes);
    signals.push({
      signal: 'SLA_REMAINING',
      value: minutesRemaining,
      unit: 'MINUTES',
      contribution: Math.round(weights.slaUrgency * urgency),
      reason:
        minutesRemaining <= 0
          ? `Order ${order.orderId} has already passed its expected dispatch time.`
          : `Only ${minutesRemaining} minutes remain before order ${order.orderId}'s expected dispatch.`,
    });

    signals.push({
      signal: 'PICKING_INCOMPLETE',
      value: !pickingComplete,
      contribution: pickingComplete ? 0 : weights.pickingIncomplete,
      reason: pickingComplete
        ? 'Picking is complete for this order.'
        : tasks.length === 0
          ? 'No picking tasks have been created for this order yet.'
          : 'One or more picking tasks for this order are not yet COMPLETED.',
    });

    signals.push({
      signal: 'PACKING_INCOMPLETE',
      value: !packingRecorded,
      contribution: packingRecorded ? 0 : weights.packingIncomplete,
      reason: packingRecorded ? 'A packing record already exists for this order.' : 'No packing record exists yet for this order.',
    });

    if (order.priority === 'URGENT' || order.priority === 'HIGH') {
      const contribution = order.priority === 'URGENT' ? weights.priorityUrgent : weights.priorityHigh;
      signals.push({
        signal: 'ORDER_PRIORITY',
        value: order.priority,
        contribution,
        reason: `Order priority is ${order.priority}, raising operational urgency.`,
      });
    }

    signals.push({
      signal: 'ITEMS_PENDING',
      value: pendingItems,
      contribution: pendingItems > 0 ? weights.itemsPending : 0,
      reason: pendingItems > 0 ? `${pendingItems} ordered units across this order's items have not yet been picked.` : 'All ordered items have been fully picked.',
    });

    return activeResult({
      predictionType: this.predictionType,
      entityType: this.entityType,
      entityId: order.orderId,
      signals,
      confidence: 'HIGH',
      predictionWindow: { value: Math.max(0, minutesRemaining), unit: 'MINUTES' },
      explanation: this.buildExplanation(order, minutesRemaining, pickingComplete, packingRecorded),
    });
  }

  private buildExplanation(order: CanonicalOrder, minutesRemaining: number, pickingComplete: boolean, packingRecorded: boolean): string {
    const parts: string[] = [];
    parts.push(
      minutesRemaining <= 0
        ? `Order ${order.orderId} has already passed its expected dispatch time.`
        : `Order ${order.orderId} is due to dispatch in ${minutesRemaining} minutes.`,
    );
    if (!pickingComplete) parts.push('Picking is not yet complete.');
    if (!packingRecorded) parts.push('Packing has not yet been recorded.');
    return parts.join(' ');
  }
}
