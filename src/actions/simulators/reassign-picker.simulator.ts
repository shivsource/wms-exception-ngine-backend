import { logisticsDataSource } from '../../adapters';
import { Action, ActionSimulator, SimulationResult } from '../../interfaces';
import { averageDurationMinutes, findCompletedTaskDurations } from '../../queries';
import { ActionType } from '../../types/enums';
import { minutesBetween } from '../../utils/dateTime';

/**
 * REASSIGN_PICKER — PICKING_DELAY only (the task must still be IN_PROGRESS; see action-mapper.ts
 * for why EXCESSIVE_PICKER_DISTANCE/TIME's already-COMPLETED tasks are not simulatable here).
 *
 * Deterministic projection: the new picker is the one with the fewest concurrent
 * ASSIGNED/IN_PROGRESS tasks right now (the least-loaded real alternative in current WMS data,
 * not a random pick). The projected picking time is the warehouse-wide average completion time
 * for COMPLETED tasks — the same baseline the PICKING_DELAY evidence/root-cause layers already
 * use (queries/picking.queries.ts) — capped so it never claims an improvement beyond what has
 * already elapsed.
 */
export class ReassignPickerSimulator implements ActionSimulator {
  readonly actionType = ActionType.REASSIGN_PICKER;

  async simulate(action: Action): Promise<SimulationResult> {
    const params = action.parameters as { taskId: string };
    const task = await logisticsDataSource.getPickingTaskById(params.taskId);

    if (!task || task.status !== 'IN_PROGRESS' || !task.startTime) {
      return {
        success: false,
        before: {},
        after: {},
        changes: {},
        notes: [`Task ${params.taskId} is no longer IN_PROGRESS — nothing to reassign.`],
      };
    }

    const allTasks = await logisticsDataSource.getPickingTasks();
    // Every picker known to the WMS (from any task, any status) is a candidate — including one
    // with zero currently-active tasks, which is exactly the ideal reassignment target.
    const knownPickerIds = new Set(allTasks.map((t) => t.pickerId));
    const activeCountByPicker = new Map<string, number>(Array.from(knownPickerIds, (pickerId) => [pickerId, 0]));
    for (const t of allTasks) {
      if (t.status !== 'ASSIGNED' && t.status !== 'IN_PROGRESS') continue;
      activeCountByPicker.set(t.pickerId, (activeCountByPicker.get(t.pickerId) ?? 0) + 1);
    }
    // The current task itself shouldn't count against its own picker's load comparison.
    activeCountByPicker.set(task.pickerId, Math.max(0, (activeCountByPicker.get(task.pickerId) ?? 1) - 1));

    const currentConcurrent = activeCountByPicker.get(task.pickerId) ?? 0;
    const alternatePickers = Array.from(activeCountByPicker.entries())
      .filter(([pickerId]) => pickerId !== task.pickerId)
      .sort(([aId, aCount], [bId, bCount]) => aCount - bCount || aId.localeCompare(bId));

    if (alternatePickers.length === 0) {
      return {
        success: false,
        before: { pickerId: task.pickerId, concurrentActiveTasks: currentConcurrent },
        after: {},
        changes: {},
        notes: ['No alternate picker is currently active in the WMS data — nothing to reassign to.'],
      };
    }

    const [newPickerId, newPickerConcurrent] = alternatePickers[0];
    const completedTasks = await logisticsDataSource.getPickingTasks({ status: ['COMPLETED'] });
    const avgCompletedMinutes = averageDurationMinutes(findCompletedTaskDurations(completedTasks));
    const elapsedMinutes = minutesBetween(task.startTime, new Date());
    // Never claim an improvement beyond what has already elapsed, and never claim the projected
    // time is longer than what's already happened.
    const projectedMinutes = avgCompletedMinutes > 0 ? Math.min(avgCompletedMinutes, elapsedMinutes) : elapsedMinutes;

    const before = { pickerId: task.pickerId, pickingTimeMinutes: elapsedMinutes, concurrentActiveTasks: currentConcurrent };
    const after = { pickerId: newPickerId, pickingTimeMinutes: projectedMinutes, concurrentActiveTasks: newPickerConcurrent };

    return {
      success: true,
      before,
      after,
      changes: { pickerId: { from: task.pickerId, to: newPickerId } },
      notes:
        avgCompletedMinutes > 0
          ? [`Projected picking time uses the warehouse average completion time (${Math.round(avgCompletedMinutes)} min) for a non-overloaded picker.`]
          : ['No completed-task data exists yet to project a warehouse average picking time; projection defaults to current elapsed time.'],
    };
  }
}
