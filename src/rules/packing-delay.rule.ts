import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { findOrdersAwaitingPackingTooLong } from '../queries';
import { EntityType, ExceptionType } from '../types/enums';
import { classifyBySeverityThresholds } from '../utils/severity';

export class PackingDelayRule implements ExceptionRule {
  readonly name = 'PackingDelayRule';
  readonly exceptionType = ExceptionType.PACKING_DELAY;

  async evaluate(): Promise<DetectedException[]> {
    const { thresholdMinutes, severity: severityThresholds } = thresholds.packingDelay;
    const now = new Date();
    const [orders, pickingTasks, packing] = await Promise.all([
      logisticsDataSource.getOrders(),
      logisticsDataSource.getPickingTasks(),
      logisticsDataSource.getPacking(),
    ]);
    const overdue = findOrdersAwaitingPackingTooLong(orders, pickingTasks, packing, thresholdMinutes, now);
    const detectedAt = now;

    return overdue.map((order) => {
      const severity = classifyBySeverityThresholds(order.minutesWaiting, severityThresholds);

      return {
        type: this.exceptionType,
        severity,
        entityType: EntityType.ORDER,
        entityId: order.orderId,
        title: `Packing delay for order ${order.orderId}`,
        description: `Order ${order.orderId} finished picking ${order.minutesWaiting} minutes ago and still has no packing record.`,
        evidence: {
          orderCode: order.orderId,
          lastPickingCompletedAt: order.lastPickingCompletedAt,
          minutesWaiting: order.minutesWaiting,
        },
        detectedAt,
      };
    });
  }
}
