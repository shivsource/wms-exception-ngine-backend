import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { averageDurationMinutes, findCompletedTaskDurations } from '../queries';
import { EntityType, ExceptionSeverity, ExceptionType } from '../types/enums';
import { classifyByRatio } from '../utils/severity';

export class ExcessivePickingTimeRule implements ExceptionRule {
  readonly name = 'ExcessivePickingTimeRule';
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKING_TIME;

  async evaluate(): Promise<DetectedException[]> {
    const tasks = await logisticsDataSource.getPickingTasks({ status: ['COMPLETED'] });
    const durations = findCompletedTaskDurations(tasks);
    const averageMinutes = averageDurationMinutes(durations);
    const detectedAt = new Date();

    if (averageMinutes <= 0) return [];

    return durations
      .map(({ task, durationMinutes }) => ({
        task,
        durationMinutes,
        severity: classifyByRatio(durationMinutes, averageMinutes, thresholds.excessivePickingTime),
      }))
      .filter(({ severity }) => severity !== ExceptionSeverity.LOW)
      .map(({ task, durationMinutes, severity }) => ({
        type: this.exceptionType,
        severity,
        entityType: EntityType.PICKING_TASK,
        entityId: task.taskId,
        title: `Excessive picking time on task ${task.taskId}`,
        description: `Picker ${task.pickerId} took ${durationMinutes} minutes, vs a warehouse average of ${averageMinutes.toFixed(1)} minutes.`,
        evidence: {
          taskCode: task.taskId,
          pickerId: task.pickerId,
          orderId: task.orderId,
          pickingMinutes: durationMinutes,
          warehouseAverageMinutes: Math.round(averageMinutes * 100) / 100,
          ratio: Math.round((durationMinutes / averageMinutes) * 100) / 100,
        },
        detectedAt,
      }));
  }
}
