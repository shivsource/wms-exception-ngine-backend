import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { findOrdersAtRiskOfSlaBreach } from '../queries';
import { EntityType, ExceptionType } from '../types/enums';
import { minutesBetween } from '../utils/dateTime';
import { classifyBySeverityThresholds } from '../utils/severity';

export class SlaAtRiskRule implements ExceptionRule {
  readonly name = 'SlaAtRiskRule';
  readonly exceptionType = ExceptionType.SLA_AT_RISK;

  async evaluate(): Promise<DetectedException[]> {
    const { windowMinutes, severity: severityThresholds } = thresholds.slaAtRisk;
    const now = new Date();
    const allOrders = await logisticsDataSource.getOrders({ excludeStatus: ['DISPATCHED', 'CANCELLED'] });
    const orders = findOrdersAtRiskOfSlaBreach(allOrders, windowMinutes, now);

    return orders.map((order) => {
      const minutesRemaining = minutesBetween(now, order.expectedDispatchTime);
      const urgencyRatio = 1 - minutesRemaining / windowMinutes;
      const severity = classifyBySeverityThresholds(urgencyRatio, severityThresholds);
      const breached = minutesRemaining <= 0;

      return {
        type: this.exceptionType,
        severity,
        entityType: EntityType.ORDER,
        entityId: order.orderId,
        title: breached
          ? `Order ${order.orderId} has breached its SLA`
          : `Order ${order.orderId} is at risk of missing its SLA`,
        description: breached
          ? `Order ${order.orderId} was expected to dispatch ${Math.abs(minutesRemaining)} minutes ago and is still ${order.status}.`
          : `Order ${order.orderId} is due to dispatch in ${minutesRemaining} minutes and is still ${order.status}.`,
        evidence: {
          orderCode: order.orderId,
          status: order.status,
          orderTime: order.orderTime,
          expectedDispatch: order.expectedDispatchTime,
          minutesRemaining,
        },
        detectedAt: now,
      };
    });
  }
}
