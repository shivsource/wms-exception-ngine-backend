import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { findPickingErrorGroups } from '../queries';
import { EntityType, ExceptionType } from '../types/enums';
import { classifyBySeverityThresholds } from '../utils/severity';

export class PickingErrorRule implements ExceptionRule {
  readonly name = 'PickingErrorRule';
  readonly exceptionType = ExceptionType.PICKING_ERROR;

  async evaluate(): Promise<DetectedException[]> {
    const tasks = await logisticsDataSource.getPickingTasks();
    const groups = findPickingErrorGroups(tasks);
    const detectedAt = new Date();

    return groups.map((group) => {
      const severity = classifyBySeverityThresholds(group.errors.length, thresholds.pickingError);

      return {
        type: this.exceptionType,
        severity,
        entityType: EntityType.PICKING_TASK,
        entityId: group.taskId,
        title: `Picking errors on task ${group.taskId}`,
        description: `${group.errors.length} picking error(s) recorded for picker ${group.pickerId} on order ${group.orderId}.`,
        evidence: {
          taskCode: group.taskId,
          pickerId: group.pickerId,
          orderId: group.orderId,
          errorCount: group.errors.length,
          errors: group.errors.map((item) => ({
            sku: item.sku,
            location: item.location,
            requestedQuantity: item.requestedQuantity,
            pickedQuantity: item.pickedQuantity,
            errorReason: item.errorReason,
          })),
        },
        detectedAt,
      };
    });
  }
}
