import { logisticsDataSource } from '../adapters';
import { EvidenceCollector, PersistedException, PickingErrorEvidence, PickingErrorEvidenceItem } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { toOrderContext } from './shared';

interface RawPickingErrorItem {
  sku: string;
  location: string;
  requestedQuantity: number;
  pickedQuantity: number | null;
  errorReason: string;
}

export class PickingErrorEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.PICKING_ERROR;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<PickingErrorEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const taskCode = raw.taskCode as string;
    const pickerId = raw.pickerId as string;
    const orderId = raw.orderId as string;
    const rawErrors = raw.errors as RawPickingErrorItem[];

    const [task, order] = await Promise.all([
      logisticsDataSource.getPickingTaskById(taskCode),
      logisticsDataSource.getOrderById(orderId),
    ]);

    const errors: PickingErrorEvidenceItem[] = await Promise.all(
      rawErrors.map(async (item) => {
        const product = await logisticsDataSource.getProductBySku(item.sku);
        return {
          sku: item.sku,
          productName: product?.name ?? null,
          location: item.location,
          requestedQuantity: item.requestedQuantity,
          pickedQuantity: item.pickedQuantity,
          errorReason: item.errorReason,
        };
      }),
    );

    return {
      task: {
        id: taskCode,
        taskCode,
        pickerId,
        status: task?.status ?? null,
        startTime: task?.startTime ?? null,
        endTime: task?.endTime ?? null,
      },
      order: order ? toOrderContext(order) : null,
      errorCount: errors.length,
      errors,
    };
  }
}
