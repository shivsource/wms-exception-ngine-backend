import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { findOrdersAwaitingDispatchTooLong } from '../queries';
import { EntityType, ExceptionType } from '../types/enums';
import { classifyBySeverityThresholds } from '../utils/severity';

export class DispatchDelayRule implements ExceptionRule {
  readonly name = 'DispatchDelayRule';
  readonly exceptionType = ExceptionType.DISPATCH_DELAY;

  async evaluate(): Promise<DetectedException[]> {
    const { thresholdMinutes, severity: severityThresholds } = thresholds.dispatchDelay;
    const now = new Date();
    const [packing, dispatch] = await Promise.all([
      logisticsDataSource.getPacking(),
      logisticsDataSource.getDispatch(),
    ]);
    const overdue = findOrdersAwaitingDispatchTooLong(packing, dispatch, thresholdMinutes, now);
    const detectedAt = now;

    return overdue.map((order) => {
      const severity = classifyBySeverityThresholds(order.minutesWaiting, severityThresholds);

      return {
        type: this.exceptionType,
        severity,
        entityType: EntityType.ORDER,
        entityId: order.orderId,
        title: `Dispatch delay for order ${order.orderId}`,
        description: `Order ${order.orderId} was packed ${order.minutesWaiting} minutes ago and has not yet departed.`,
        evidence: {
          orderCode: order.orderId,
          packingTime: order.packingTime,
          minutesWaiting: order.minutesWaiting,
        },
        detectedAt,
      };
    });
  }
}
