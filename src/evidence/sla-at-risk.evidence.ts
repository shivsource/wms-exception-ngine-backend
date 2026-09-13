import { logisticsDataSource } from '../adapters';
import { EvidenceCollector, PersistedException, SlaAtRiskEvidence } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { toOrderContext, toOrderItemProgress } from './shared';

export class SlaAtRiskEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.SLA_AT_RISK;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<SlaAtRiskEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const orderCode = raw.orderCode as string;
    const minutesRemaining = raw.minutesRemaining as number;

    const order = await logisticsDataSource.getOrderById(orderCode);
    const enrichedItems = await Promise.all((order?.items ?? []).map(toOrderItemProgress));

    return {
      order: order
        ? {
            ...toOrderContext(order),
            orderTime: order.orderTime,
            minutesRemaining,
            breached: minutesRemaining <= 0,
          }
        : null,
      items: enrichedItems,
    };
  }
}
