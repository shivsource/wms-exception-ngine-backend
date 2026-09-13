import { logisticsDataSource } from '../adapters';
import { CanonicalOrder, CanonicalOrderItem, CanonicalPickingTaskItem } from '../canonical/types';
import { OrderContext, OrderItemProgress, PickingTaskItemContext } from '../interfaces';

/** Maps a canonical order to the shared OrderContext shape used across every order-linked collector. */
export function toOrderContext(order: CanonicalOrder): OrderContext {
  return {
    orderId: order.orderId,
    customerId: order.customerId,
    priority: order.priority,
    expectedDispatch: order.expectedDispatchTime,
    status: order.status,
  };
}

/** Enriches a canonical picking task item with its product's display name and remaining pending quantity. */
export async function toPickingTaskItemContext(item: CanonicalPickingTaskItem): Promise<PickingTaskItemContext> {
  const product = await logisticsDataSource.getProductBySku(item.sku);
  const pickedQuantity = item.pickedQuantity ?? 0;
  return {
    sku: item.sku,
    productName: product?.name ?? null,
    location: item.locationId,
    requestedQuantity: item.requestedQuantity,
    pickedQuantity: item.pickedQuantity,
    pending: item.requestedQuantity - pickedQuantity,
  };
}

/** Enriches a canonical order item with its product's display name — order-level progress rather than task-level. */
export async function toOrderItemProgress(item: CanonicalOrderItem): Promise<OrderItemProgress> {
  const product = await logisticsDataSource.getProductBySku(item.sku);
  return {
    sku: item.sku,
    productName: product?.name ?? null,
    orderedQuantity: item.orderedQuantity,
    pickedQuantity: item.pickedQuantity,
    packedQuantity: item.packedQuantity,
  };
}
