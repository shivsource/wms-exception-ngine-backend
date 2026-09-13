import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { findStuckInProgressTasks } from '../queries';
import { EntityType, ExceptionType } from '../types/enums';
import { minutesBetween } from '../utils/dateTime';
import { classifyBySeverityThresholds } from '../utils/severity';

export class PickingDelayRule implements ExceptionRule {
  readonly name = 'PickingDelayRule';
  readonly exceptionType = ExceptionType.PICKING_DELAY;

  async evaluate(): Promise<DetectedException[]> {
    const now = new Date();
    const tasks = await logisticsDataSource.getPickingTasks({ status: ['IN_PROGRESS'] });
    const stuckTasks = findStuckInProgressTasks(tasks, thresholds.pickingDelay.stuckAfterMinutes, now);

    return stuckTasks.map((task) => {
      const elapsedMinutes = minutesBetween(task.startTime, now);
      const severity = classifyBySeverityThresholds(elapsedMinutes, thresholds.pickingDelay.severity);

      return {
        type: this.exceptionType,
        severity,
        entityType: EntityType.PICKING_TASK,
        entityId: task.taskId,
        title: `Picking delay on task ${task.taskId}`,
        description: `Task ${task.taskId} has been IN_PROGRESS for ${elapsedMinutes} minutes without completing.`,
        evidence: {
          taskCode: task.taskId,
          pickerId: task.pickerId,
          orderId: task.orderId,
          startTime: task.startTime,
          elapsedMinutes,
        },
        detectedAt: now,
      };
    });
  }
}
