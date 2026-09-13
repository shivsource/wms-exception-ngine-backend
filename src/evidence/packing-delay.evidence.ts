import { logisticsDataSource } from '../adapters';
import { EvidenceCollector, PackingDelayEvidence, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { toOrderContext, toOrderItemProgress } from './shared';

export class PackingDelayEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.PACKING_DELAY;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<PackingDelayEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const orderCode = raw.orderCode as string;
    const lastPickingCompletedAt = new Date(raw.lastPickingCompletedAt as string);
    const minutesWaiting = raw.minutesWaiting as number;

    const order = await logisticsDataSource.getOrderById(orderCode);
    const enrichedItems = await Promise.all((order?.items ?? []).map(toOrderItemProgress));

    return {
      order: order ? toOrderContext(order) : null,
      lastPickingCompletedAt,
      minutesWaiting,
      items: enrichedItems,
    };
  }
}
