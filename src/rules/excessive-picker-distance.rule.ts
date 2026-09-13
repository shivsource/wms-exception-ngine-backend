import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { averageDistanceWalked, findCompletedTaskDistances } from '../queries';
import { EntityType, ExceptionSeverity, ExceptionType } from '../types/enums';
import { classifyByRatio } from '../utils/severity';

export class ExcessivePickerDistanceRule implements ExceptionRule {
  readonly name = 'ExcessivePickerDistanceRule';
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKER_DISTANCE;

  async evaluate(): Promise<DetectedException[]> {
    const tasks = await logisticsDataSource.getPickingTasks({ status: ['COMPLETED'] });
    const distances = findCompletedTaskDistances(tasks);
    const averageDistance = averageDistanceWalked(distances);
    const detectedAt = new Date();

    if (averageDistance <= 0) return [];

    return distances
      .map(({ task, distanceWalked }) => ({
        task,
        distanceWalked,
        severity: classifyByRatio(distanceWalked, averageDistance, thresholds.excessivePickerDistance),
      }))
      .filter(({ severity }) => severity !== ExceptionSeverity.LOW)
      .map(({ task, distanceWalked, severity }) => ({
        type: this.exceptionType,
        severity,
        entityType: EntityType.PICKING_TASK,
        entityId: task.taskId,
        title: `Excessive picker distance on task ${task.taskId}`,
        description: `Picker ${task.pickerId} walked ${distanceWalked}m, vs a warehouse average of ${averageDistance.toFixed(1)}m.`,
        evidence: {
          taskCode: task.taskId,
          pickerId: task.pickerId,
          orderId: task.orderId,
          distanceWalked,
          warehouseAverageDistance: Math.round(averageDistance * 100) / 100,
          ratio: Math.round((distanceWalked / averageDistance) * 100) / 100,
        },
        detectedAt,
      }));
  }
}
