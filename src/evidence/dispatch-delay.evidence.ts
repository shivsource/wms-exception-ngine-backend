import { logisticsDataSource } from '../adapters';
import { DispatchDelayEvidence, EvidenceCollector, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { toOrderContext } from './shared';

export class DispatchDelayEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.DISPATCH_DELAY;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<DispatchDelayEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const orderCode = raw.orderCode as string;
    const minutesWaiting = raw.minutesWaiting as number;

    const order = await logisticsDataSource.getOrderById(orderCode);
    const packingRecords = order ? await logisticsDataSource.getPacking({ orderId: order.orderId }) : [];
    // Dispatch delay fires once an order is packed but hasn't departed; there is at
    // most one relevant packing record per order at that point, so take the first.
    const packing = packingRecords[0] ?? null;

    return {
      order: order ? toOrderContext(order) : null,
      packing: packing
        ? {
            packingTime: packing.packingTime,
            packageSize: packing.packageSize,
            weight: packing.weight,
            damaged: packing.damaged,
            packedBy: packing.packedBy,
          }
        : null,
      minutesWaiting,
    };
  }
}
