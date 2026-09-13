import { CanonicalPickingTask } from '../canonical/types';
import { minutesBetween } from '../utils/dateTime';

/** See inventory.queries.ts header — same "adapter transforms, this classifies" split. */

/** Tasks actively IN_PROGRESS for longer than the given threshold — picking that is stuck/running late. */
export function findStuckInProgressTasks(
  tasks: CanonicalPickingTask[],
  minutesThreshold: number,
  now: Date,
): (CanonicalPickingTask & { startTime: Date })[] {
  return tasks.filter(
    (task): task is CanonicalPickingTask & { startTime: Date } =>
      task.status === 'IN_PROGRESS' && task.startTime !== null && minutesBetween(task.startTime, now) > minutesThreshold,
  );
}

export interface CompletedTaskDuration {
  task: CanonicalPickingTask;
  durationMinutes: number;
}

export function findCompletedTaskDurations(tasks: CanonicalPickingTask[]): CompletedTaskDuration[] {
  return tasks
    .filter((task) => task.status === 'COMPLETED' && task.startTime !== null && task.endTime !== null)
    .map((task) => ({ task, durationMinutes: minutesBetween(task.startTime as Date, task.endTime as Date) }));
}

export function averageDurationMinutes(durations: CompletedTaskDuration[]): number {
  if (durations.length === 0) return 0;
  return durations.reduce((sum, d) => sum + d.durationMinutes, 0) / durations.length;
}

export interface CompletedTaskDistance {
  task: CanonicalPickingTask;
  distanceWalked: number;
}

export function findCompletedTaskDistances(tasks: CanonicalPickingTask[]): CompletedTaskDistance[] {
  return tasks
    .filter((task) => task.status === 'COMPLETED' && task.distanceWalked !== null)
    .map((task) => ({ task, distanceWalked: task.distanceWalked as number }));
}

export function averageDistanceWalked(distances: CompletedTaskDistance[]): number {
  if (distances.length === 0) return 0;
  return distances.reduce((sum, d) => sum + d.distanceWalked, 0) / distances.length;
}

export interface PickingErrorGroup {
  taskId: string;
  pickerId: string;
  orderId: string;
  errors: {
    sku: string;
    location: string;
    requestedQuantity: number;
    pickedQuantity: number | null;
    errorReason: string;
  }[];
}

/** One group per task that has at least one line item with a recorded error reason. */
export function findPickingErrorGroups(tasks: CanonicalPickingTask[]): PickingErrorGroup[] {
  const groups: PickingErrorGroup[] = [];
  for (const task of tasks) {
    const errorItems = task.items.filter((item) => item.errorReason !== null);
    if (errorItems.length === 0) continue;
    groups.push({
      taskId: task.taskId,
      pickerId: task.pickerId,
      orderId: task.orderId,
      errors: errorItems.map((item) => ({
        sku: item.sku,
        location: item.locationId,
        requestedQuantity: item.requestedQuantity,
        pickedQuantity: item.pickedQuantity,
        errorReason: item.errorReason as string,
      })),
    });
  }
  return groups;
}

/** Groups picking tasks by their order — used where a filter over the LogisticsDataSource's
 *  structural PickingTaskFilter isn't enough (it has no orderId scoping), mirroring how
 *  findOrdersAwaitingPackingTooLong groups the same way. */
export function groupTasksByOrderId(tasks: CanonicalPickingTask[]): Map<string, CanonicalPickingTask[]> {
  const byOrderId = new Map<string, CanonicalPickingTask[]>();
  for (const task of tasks) {
    const group = byOrderId.get(task.orderId) ?? [];
    group.push(task);
    byOrderId.set(task.orderId, group);
  }
  return byOrderId;
}

/** Whether every picking task for an order has finished (COMPLETED) — false if there are no
 *  tasks at all, since "nothing to be done picking" is not the same as "picking is done". */
export function isOrderFullyPicked(tasks: CanonicalPickingTask[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.status === 'COMPLETED');
}

/** Other tasks currently assigned to or being worked by this picker right now — a PICKER_OVERLOAD signal for the root cause engine. */
export function countActiveTasksForPicker(tasks: CanonicalPickingTask[], pickerId: string, excludeTaskId: string): number {
  return tasks.filter(
    (task) => task.pickerId === pickerId && task.taskId !== excludeTaskId && (task.status === 'ASSIGNED' || task.status === 'IN_PROGRESS'),
  ).length;
}
