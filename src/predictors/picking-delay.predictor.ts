import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { PredictionEvaluationResult, RiskPredictor, RiskSignal } from '../interfaces';
import { averageDurationMinutes, findCompletedTaskDurations } from '../queries';
import { CanonicalOrder, CanonicalPickingTask } from '../canonical/types';
import { EntityType, PredictionType } from '../types/enums';
import { minutesBetween } from '../utils/dateTime';
import { activeResult, insufficientData, overageRatio, urgencyRatio } from './shared';

/**
 * Predicts whether a picking task currently IN_PROGRESS is likely to become a PICKING_DELAY
 * exception before it completes.
 *
 * Historical baseline: the average duration (endTime - startTime, in minutes) across every
 * COMPLETED picking task currently in the source — computed by
 * src/queries/picking.queries.ts's findCompletedTaskDurations/averageDurationMinutes, the
 * exact same functions the existing engine already uses. Below
 * thresholds.prediction.pickingDelay.minBaselineSamples completed tasks, the baseline is
 * treated as unavailable (never fabricated) and the PICKING_DURATION signal is omitted —
 * scoring falls back to the fixed-threshold and SLA-urgency signals only.
 */
export class PickingDelayPredictor implements RiskPredictor {
  readonly name = 'PickingDelayPredictor';
  readonly predictionType = PredictionType.PICKING_DELAY_RISK;
  readonly entityType = EntityType.PICKING_TASK;

  async evaluateAll(): Promise<PredictionEvaluationResult[]> {
    const now = new Date();
    const [inProgressTasks, completedTasks, orders] = await Promise.all([
      logisticsDataSource.getPickingTasks({ status: ['IN_PROGRESS'] }),
      logisticsDataSource.getPickingTasks({ status: ['COMPLETED'] }),
      logisticsDataSource.getOrders(),
    ]);
    const baseline = this.computeBaseline(completedTasks);
    const ordersById = new Map(orders.map((o) => [o.orderId, o]));

    return inProgressTasks
      .filter((task): task is CanonicalPickingTask & { startTime: Date } => task.startTime !== null)
      .map((task) => this.evaluateTask(task, baseline, ordersById.get(task.orderId) ?? null, now));
  }

  async evaluateOne(entityId: string): Promise<PredictionEvaluationResult> {
    const task = await logisticsDataSource.getPickingTaskById(entityId);
    if (!task) {
      return insufficientData(this.predictionType, this.entityType, entityId, [`Picking task ${entityId} could not be found in the source system.`]);
    }
    if (task.status !== 'IN_PROGRESS') {
      return insufficientData(this.predictionType, this.entityType, entityId, [
        `Picking task ${entityId} has status ${task.status ?? 'UNKNOWN'} — picking-delay risk only applies while a task is IN_PROGRESS.`,
      ]);
    }
    if (task.startTime === null) {
      return insufficientData(this.predictionType, this.entityType, entityId, [
        `Picking task ${entityId} is IN_PROGRESS but has no recorded start time, so elapsed duration cannot be computed.`,
      ]);
    }

    const now = new Date();
    const [completedTasks, order] = await Promise.all([
      logisticsDataSource.getPickingTasks({ status: ['COMPLETED'] }),
      logisticsDataSource.getOrderById(task.orderId),
    ]);
    return this.evaluateTask(task as CanonicalPickingTask & { startTime: Date }, this.computeBaseline(completedTasks), order, now);
  }

  private computeBaseline(completedTasks: CanonicalPickingTask[]): { minutes: number; sampleSize: number } | null {
    const durations = findCompletedTaskDurations(completedTasks);
    if (durations.length < thresholds.prediction.pickingDelay.minBaselineSamples) return null;
    return { minutes: averageDurationMinutes(durations), sampleSize: durations.length };
  }

  private evaluateTask(
    task: CanonicalPickingTask & { startTime: Date },
    baseline: { minutes: number; sampleSize: number } | null,
    order: CanonicalOrder | null,
    now: Date,
  ): PredictionEvaluationResult {
    const { weights, minBaselineSamples } = thresholds.prediction.pickingDelay;
    const { stuckAfterMinutes } = thresholds.pickingDelay;
    const elapsedMinutes = minutesBetween(task.startTime, now);
    const limitations: string[] = [];

    const signals: RiskSignal[] = [];

    if (baseline) {
      signals.push({
        signal: 'PICKING_DURATION',
        value: elapsedMinutes,
        expected: Math.round(baseline.minutes),
        unit: 'MINUTES',
        contribution: Math.round(weights.durationVsBaseline * overageRatio(elapsedMinutes, baseline.minutes, thresholds.prediction.pickingDelay.durationBaselineSaturationRatio)),
        reason: `Elapsed picking time (${elapsedMinutes}m) compared against the historical average of ${Math.round(baseline.minutes)}m across ${baseline.sampleSize} completed tasks.`,
      });
    } else {
      limitations.push(
        `INSUFFICIENT_BASELINE_DATA: fewer than ${minBaselineSamples} completed picking tasks are available, so no historical duration baseline could be computed. The PICKING_DURATION signal was omitted from scoring.`,
      );
    }

    if (order) {
      const minutesRemaining = minutesBetween(now, order.expectedDispatchTime);
      const urgency = urgencyRatio(minutesRemaining, thresholds.slaAtRisk.windowMinutes);
      signals.push({
        signal: 'SLA_REMAINING',
        value: minutesRemaining,
        unit: 'MINUTES',
        contribution: Math.round(weights.slaUrgency * urgency),
        reason: `Order ${order.orderId} has ${minutesRemaining} minutes remaining before its expected dispatch.`,
      });
    } else {
      limitations.push(`Order ${task.orderId} for this task could not be found, so SLA-remaining could not be evaluated.`);
    }

    signals.push({
      signal: 'ELAPSED_VS_STUCK_THRESHOLD',
      value: elapsedMinutes,
      expected: stuckAfterMinutes,
      unit: 'MINUTES',
      contribution: Math.round(weights.elapsedVsThreshold * Math.min(1, elapsedMinutes / stuckAfterMinutes)),
      reason: `This task has been IN_PROGRESS for ${elapsedMinutes} of the ${stuckAfterMinutes} minutes that would trigger a PICKING_DELAY exception.`,
    });

    const itemCount = task.items.length;
    const totalQuantity = task.items.reduce((sum, item) => sum + item.requestedQuantity, 0);
    const { itemCountHigh, totalQuantityHigh } = thresholds.rootCause.pickingDelay.complexity;
    const highComplexity = itemCount >= itemCountHigh || totalQuantity >= totalQuantityHigh;
    signals.push({
      signal: 'TASK_COMPLEXITY',
      value: itemCount,
      contribution: highComplexity ? weights.highComplexity : 0,
      reason: highComplexity
        ? `This task has ${itemCount} line items / ${totalQuantity} units, above the high-complexity threshold.`
        : `This task has ${itemCount} line items / ${totalQuantity} units — not unusually complex.`,
    });

    signals.push({
      signal: 'RECORDED_ERRORS',
      value: task.errors,
      contribution: task.errors > 0 ? weights.hasErrors : 0,
      reason: task.errors > 0 ? `${task.errors} error(s) already recorded on this task.` : 'No errors recorded on this task so far.',
    });

    return activeResult({
      predictionType: this.predictionType,
      entityType: this.entityType,
      entityId: task.taskId,
      signals,
      confidence: baseline && order ? 'HIGH' : baseline || order ? 'MEDIUM' : 'LOW',
      predictionWindow: { value: Math.max(0, stuckAfterMinutes - elapsedMinutes), unit: 'MINUTES' },
      explanation: `Task ${task.taskId} has been picking for ${elapsedMinutes} minutes${baseline ? ` against a historical average of ${Math.round(baseline.minutes)} minutes` : ''}${order ? `, with ${Math.max(0, minutesBetween(now, order.expectedDispatchTime))} minutes remaining before its order's expected dispatch` : ''}.`,
      limitations,
    });
  }
}
