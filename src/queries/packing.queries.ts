import { CanonicalOrder, CanonicalPacking, CanonicalPickingTask } from '../canonical/types';
import { minutesBetween } from '../utils/dateTime';

/** See inventory.queries.ts header — same "adapter transforms, this classifies" split. */

export interface OrderAwaitingPacking {
  orderId: string;
  lastPickingCompletedAt: Date;
  minutesWaiting: number;
}

/**
 * Orders whose picking is fully COMPLETED but have no packing record yet, and where the
 * time since the last picking task finished exceeds the given threshold. An order with
 * zero picking tasks never appears (nothing to be "done picking"), matching the
 * original inner-join-on-picking_tasks semantics.
 */
export function findOrdersAwaitingPackingTooLong(
  orders: CanonicalOrder[],
  pickingTasks: CanonicalPickingTask[],
  packing: CanonicalPacking[],
  minutesThreshold: number,
  now: Date,
): OrderAwaitingPacking[] {
  const packedOrderIds = new Set(packing.map((p) => p.orderId));

  const tasksByOrderId = new Map<string, CanonicalPickingTask[]>();
  for (const task of pickingTasks) {
    const group = tasksByOrderId.get(task.orderId) ?? [];
    group.push(task);
    tasksByOrderId.set(task.orderId, group);
  }

  const result: OrderAwaitingPacking[] = [];
  for (const order of orders) {
    if (packedOrderIds.has(order.orderId)) continue;

    const tasks = tasksByOrderId.get(order.orderId);
    if (!tasks || tasks.length === 0) continue;

    // A task with no recorded status is treated as not blocking (matches the original
    // SQL's CASE WHEN status <> 'COMPLETED' — NULL <> 'COMPLETED' is NULL, so it never
    // counts as "not completed" there either).
    const allCompleted = tasks.every((task) => task.status === 'COMPLETED' || task.status === null);
    if (!allCompleted) continue;

    const endTimes = tasks.map((task) => task.endTime).filter((d): d is Date => d !== null);
    if (endTimes.length === 0) continue;

    const lastPickingCompletedAt = new Date(Math.max(...endTimes.map((d) => d.getTime())));
    const minutesWaiting = minutesBetween(lastPickingCompletedAt, now);
    if (minutesWaiting > minutesThreshold) {
      result.push({ orderId: order.orderId, lastPickingCompletedAt, minutesWaiting });
    }
  }
  return result;
}
