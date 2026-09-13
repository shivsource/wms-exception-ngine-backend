import { logisticsDataSource } from '../adapters';
import { EvidenceCollector, PersistedException, PickingDelayEvidence } from '../interfaces';
import { averageDurationMinutes, findCompletedTaskDurations } from '../queries';
import { ExceptionType } from '../types/enums';
import { toOrderContext, toPickingTaskItemContext } from './shared';

export class PickingDelayEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.PICKING_DELAY;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<PickingDelayEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const taskCode = raw.taskCode as string;
    const pickerId = raw.pickerId as string;
    const orderId = raw.orderId as string;
    const startTime = new Date(raw.startTime as string);
    const elapsedMinutes = raw.elapsedMinutes as number;

    const [order, task, completedTasks] = await Promise.all([
      logisticsDataSource.getOrderById(orderId),
      logisticsDataSource.getPickingTaskById(taskCode),
      logisticsDataSource.getPickingTasks({ status: ['COMPLETED'] }),
    ]);
    const avgCompletedMinutes = averageDurationMinutes(findCompletedTaskDurations(completedTasks));

    const items = await Promise.all((task?.items ?? []).map(toPickingTaskItemContext));

    return {
      task: { id: taskCode, taskCode, pickerId, startTime, elapsedMinutes },
      order: order ? toOrderContext(order) : null,
      items,
      baseline: {
        avgCompletedMinutes,
        delayRatio: avgCompletedMinutes > 0 ? elapsedMinutes / avgCompletedMinutes : null,
      },
    };
  }
}
