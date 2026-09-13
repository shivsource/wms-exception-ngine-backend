import { logisticsDataSource } from '../adapters';
import { EvidenceCollector, ExcessivePickerDistanceEvidence, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { toOrderContext, toPickingTaskItemContext } from './shared';

export class ExcessivePickerDistanceEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKER_DISTANCE;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<ExcessivePickerDistanceEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const taskCode = raw.taskCode as string;
    const pickerId = raw.pickerId as string;
    const orderId = raw.orderId as string;
    const distanceWalked = raw.distanceWalked as number;
    const warehouseAverageDistance = raw.warehouseAverageDistance as number;
    const ratio = raw.ratio as number;

    const [order, task] = await Promise.all([
      logisticsDataSource.getOrderById(orderId),
      logisticsDataSource.getPickingTaskById(taskCode),
    ]);

    const items = await Promise.all((task?.items ?? []).map(toPickingTaskItemContext));

    return {
      task: { id: taskCode, taskCode, pickerId, distanceWalked, warehouseAverageDistance, ratio },
      order: order ? toOrderContext(order) : null,
      items,
    };
  }
}
