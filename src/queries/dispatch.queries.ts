import { CanonicalDispatch, CanonicalPacking } from '../canonical/types';
import { minutesBetween } from '../utils/dateTime';

/** See inventory.queries.ts header — same "adapter transforms, this classifies" split. */

export interface OrderAwaitingDispatch {
  orderId: string;
  packingTime: Date;
  minutesWaiting: number;
}

/** Orders that have been packed but have no recorded departure yet, waiting longer than the threshold. */
export function findOrdersAwaitingDispatchTooLong(
  packing: CanonicalPacking[],
  dispatch: CanonicalDispatch[],
  minutesThreshold: number,
  now: Date,
): OrderAwaitingDispatch[] {
  const departedOrderIds = new Set(dispatch.filter((d) => d.departureTime !== null).map((d) => d.orderId));

  const packingByOrderId = new Map<string, CanonicalPacking[]>();
  for (const record of packing) {
    const group = packingByOrderId.get(record.orderId) ?? [];
    group.push(record);
    packingByOrderId.set(record.orderId, group);
  }

  const result: OrderAwaitingDispatch[] = [];
  for (const [orderId, records] of packingByOrderId) {
    if (departedOrderIds.has(orderId)) continue;

    const packingTime = new Date(Math.min(...records.map((r) => r.packingTime.getTime())));
    const minutesWaiting = minutesBetween(packingTime, now);
    if (minutesWaiting > minutesThreshold) {
      result.push({ orderId, packingTime, minutesWaiting });
    }
  }
  return result;
}

/** Other orders sitting at the same dock with no recorded departure yet — a DOCK_CONGESTION signal for the root cause engine. */
export function countAwaitingDepartureAtDock(dispatch: CanonicalDispatch[], dock: string, excludeOrderId: string): number {
  return dispatch.filter((d) => d.dock === dock && d.orderId !== excludeOrderId && d.departureTime === null).length;
}
