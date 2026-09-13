import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { PredictionEvaluationResult, RiskPredictor, RiskSignal } from '../interfaces';
import { findOrdersAtRiskOfSlaBreach, groupTasksByOrderId, isOrderFullyPicked } from '../queries';
import { CanonicalDispatch, CanonicalOrder, CanonicalPacking, CanonicalPickingTask } from '../canonical/types';
import { EntityType, PredictionType } from '../types/enums';
import { minutesBetween } from '../utils/dateTime';
import { activeResult, insufficientData, urgencyRatio } from './shared';

/**
 * Predicts whether an order not yet departed is likely to become a DISPATCH_DELAY exception.
 * Only uses fields the schema actually has for this stage (packing time, dispatch/departure
 * time, expected dispatch time, picking completion) — never truck/carrier/dock data, since
 * the schema has no truck schedule or carrier SLA to compare against (see Step 10 in the
 * brief this module was built from): dock/truck/carrier are reported as context elsewhere
 * (evidence/root-cause) but never scored here.
 */
export class DispatchDelayPredictor implements RiskPredictor {
  readonly name = 'DispatchDelayPredictor';
  readonly predictionType = PredictionType.DISPATCH_DELAY_RISK;
  readonly entityType = EntityType.ORDER;

  async evaluateAll(): Promise<PredictionEvaluationResult[]> {
    const now = new Date();
    const { windowMinutes } = thresholds.prediction.dispatchDelay;
    const [allOrders, allTasks, allPacking, allDispatch] = await Promise.all([
      logisticsDataSource.getOrders({ excludeStatus: ['DISPATCHED', 'CANCELLED'] }),
      logisticsDataSource.getPickingTasks(),
      logisticsDataSource.getPacking(),
      logisticsDataSource.getDispatch(),
    ]);
    const candidates = findOrdersAtRiskOfSlaBreach(allOrders, windowMinutes, now);
    const tasksByOrderId = groupTasksByOrderId(allTasks);
    const packingByOrderId = this.groupByOrderId(allPacking);
    const dispatchByOrderId = this.groupByOrderId(allDispatch);

    return candidates.map((order) =>
      this.evaluateOrder(order, tasksByOrderId.get(order.orderId) ?? [], packingByOrderId.get(order.orderId) ?? [], dispatchByOrderId.get(order.orderId) ?? [], now),
    );
  }

  async evaluateOne(entityId: string): Promise<PredictionEvaluationResult> {
    const order = await logisticsDataSource.getOrderById(entityId);
    if (!order) {
      return insufficientData(this.predictionType, this.entityType, entityId, [`Order ${entityId} could not be found in the source system.`]);
    }
    if (order.status === null) {
      return insufficientData(this.predictionType, this.entityType, entityId, [`Order ${entityId} has no recorded status, so its fulfillment stage cannot be assessed.`]);
    }
    if (order.status === 'DISPATCHED' || order.status === 'CANCELLED') {
      return insufficientData(this.predictionType, this.entityType, entityId, [`Order ${entityId} is already ${order.status} — dispatch-delay risk is no longer applicable.`]);
    }

    const now = new Date();
    const [allTasks, packing, dispatch] = await Promise.all([
      logisticsDataSource.getPickingTasks(),
      logisticsDataSource.getPacking({ orderId: entityId }),
      logisticsDataSource.getDispatch({ orderId: entityId }),
    ]);
    return this.evaluateOrder(order, groupTasksByOrderId(allTasks).get(entityId) ?? [], packing, dispatch, now);
  }

  private groupByOrderId<T extends { orderId: string }>(records: T[]): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const record of records) {
      const group = map.get(record.orderId) ?? [];
      group.push(record);
      map.set(record.orderId, group);
    }
    return map;
  }

  private evaluateOrder(
    order: CanonicalOrder,
    tasks: CanonicalPickingTask[],
    packing: CanonicalPacking[],
    dispatch: CanonicalDispatch[],
    now: Date,
  ): PredictionEvaluationResult {
    const { windowMinutes, weights } = thresholds.prediction.dispatchDelay;
    const { thresholdMinutes } = thresholds.dispatchDelay;

    const minutesRemaining = minutesBetween(now, order.expectedDispatchTime);
    const departed = dispatch.some((d) => d.departureTime !== null);
    const packingRecorded = packing.length > 0;
    const pickingComplete = isOrderFullyPicked(tasks);
    const earliestPackingTime = packingRecorded ? new Date(Math.min(...packing.map((p) => p.packingTime.getTime()))) : null;
    const minutesSincePacked = earliestPackingTime ? minutesBetween(earliestPackingTime, now) : null;

    const signals: RiskSignal[] = [];

    signals.push({
      signal: 'SLA_REMAINING',
      value: minutesRemaining,
      unit: 'MINUTES',
      contribution: Math.round(weights.slaUrgency * urgencyRatio(minutesRemaining, windowMinutes)),
      reason:
        minutesRemaining <= 0
          ? `Order ${order.orderId} has already passed its expected dispatch time.`
          : `Order ${order.orderId} is due to dispatch in ${minutesRemaining} minutes.`,
    });

    if (packingRecorded && !departed && minutesSincePacked !== null) {
      signals.push({
        signal: 'PACKING_ELAPSED',
        value: minutesSincePacked,
        expected: thresholdMinutes,
        unit: 'MINUTES',
        contribution: Math.round(weights.packingElapsedVsThreshold * Math.min(1, minutesSincePacked / thresholdMinutes)),
        reason: `Order ${order.orderId} was packed ${minutesSincePacked} of the ${thresholdMinutes} minutes that would trigger a DISPATCH_DELAY exception, with no recorded departure yet.`,
      });
    } else {
      signals.push({
        signal: 'PACKING_ELAPSED',
        value: null,
        expected: thresholdMinutes,
        unit: 'MINUTES',
        contribution: 0,
        reason: departed ? 'This order has already departed.' : 'This order has not been packed yet, so packing-elapsed time does not apply.',
      });
    }

    signals.push({
      signal: 'PICKING_INCOMPLETE',
      value: !pickingComplete,
      contribution: pickingComplete ? 0 : weights.pickingIncomplete,
      reason: pickingComplete ? 'Picking is complete for this order.' : 'Picking is not yet complete for this order.',
    });

    signals.push({
      signal: 'NOT_YET_PACKED',
      value: !packingRecorded,
      contribution: packingRecorded ? 0 : weights.notYetPacked,
      reason: packingRecorded ? 'A packing record already exists for this order.' : 'No packing record exists yet for this order.',
    });

    const windowValue = packingRecorded && !departed && minutesSincePacked !== null ? Math.max(0, thresholdMinutes - minutesSincePacked) : Math.max(0, minutesRemaining);

    return activeResult({
      predictionType: this.predictionType,
      entityType: this.entityType,
      entityId: order.orderId,
      signals,
      confidence: 'HIGH',
      predictionWindow: { value: windowValue, unit: 'MINUTES' },
      explanation: `Order ${order.orderId}${packingRecorded ? (departed ? ' has departed' : `, packed ${minutesSincePacked}m ago, has not yet departed`) : ' has not yet been packed'}, with ${Math.max(0, minutesRemaining)} minutes remaining before its expected dispatch.`,
      limitations: ['Truck/carrier/dock data is not used to score this prediction — the source schema has no truck schedule or carrier SLA to compare against.'],
    });
  }
}
