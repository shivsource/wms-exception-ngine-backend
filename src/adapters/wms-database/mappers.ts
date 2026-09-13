import {
  CanonicalDispatch,
  CanonicalInventory,
  CanonicalOrder,
  CanonicalOrderItem,
  CanonicalOrderPriority,
  CanonicalOrderStatus,
  CanonicalPacking,
  CanonicalPickingTask,
  CanonicalPickingTaskItem,
  CanonicalPickingTaskStatus,
  CanonicalProduct,
  CanonicalReturn,
  CanonicalReturnCondition,
} from '../../canonical/types';
import {
  DispatchRow,
  InventoryRow,
  OrderItemRow,
  OrderRow,
  PackingRow,
  PickingTaskItemRow,
  PickingTaskRow,
  ProductRow,
  ReturnRow,
} from '../../types/wms.types';

/**
 * Raised when a single WMS row can't be mapped into a valid canonical entity (a missing
 * required field, an invalid timestamp, ...). The adapter catches this per-record so one
 * malformed row never corrupts or aborts an otherwise-good bulk fetch — see
 * WmsDatabaseAdapter and ARCHITECTURE.md's "Error handling" section.
 */
export class MappingError extends Error {
  constructor(
    public readonly entity: string,
    public readonly sourceId: string | number,
    reason: string,
  ) {
    super(`Failed to map ${entity} ${sourceId} from wms_database: ${reason}`);
    this.name = 'MappingError';
  }
}

function requireValidDate(value: Date | null | undefined, entity: string, sourceId: string | number, field: string): Date {
  if (!value || Number.isNaN(new Date(value).getTime())) {
    throw new MappingError(entity, sourceId, `missing/invalid required timestamp field "${field}"`);
  }
  return new Date(value);
}

function optionalDate(value: Date | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const ORDER_PRIORITIES: ReadonlySet<string> = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const ORDER_STATUSES: ReadonlySet<string> = new Set([
  'RECEIVED',
  'ALLOCATED',
  'PICKING',
  'PACKING',
  'READY_TO_DISPATCH',
  'DISPATCHED',
  'CANCELLED',
  'ON_HOLD',
]);
const PICKING_TASK_STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
const RETURN_CONDITIONS: ReadonlySet<string> = new Set(['NEW', 'GOOD', 'DAMAGED', 'DEFECTIVE', 'USED', 'UNKNOWN']);

/** An unrecognized enum value degrades to null (unsupported status) rather than throwing — see ARCHITECTURE.md. */
function toEnum<T extends string>(value: string | null | undefined, allowed: ReadonlySet<string>): T | null {
  if (value && allowed.has(value)) return value as T;
  return null;
}

export function mapOrder(row: OrderRow, itemRows: OrderItemRow[]): CanonicalOrder {
  if (!row.order_id) throw new MappingError('Order', row.id, 'missing required field "order_id"');
  if (!row.customer_id) throw new MappingError('Order', row.order_id, 'missing required field "customer_id"');

  return {
    orderId: row.order_id,
    customerId: row.customer_id,
    priority: toEnum<CanonicalOrderPriority>(row.priority, ORDER_PRIORITIES),
    orderTime: requireValidDate(row.order_time, 'Order', row.order_id, 'order_time'),
    expectedDispatchTime: requireValidDate(row.expected_dispatch, 'Order', row.order_id, 'expected_dispatch'),
    status: toEnum<CanonicalOrderStatus>(row.status, ORDER_STATUSES),
    items: itemRows.map(mapOrderItem),
  };
}

export function mapOrderItem(row: OrderItemRow): CanonicalOrderItem {
  return {
    sku: row.sku,
    orderedQuantity: row.quantity,
    pickedQuantity: row.picked_quantity,
    packedQuantity: row.packed_quantity,
  };
}

export function mapProduct(row: ProductRow): CanonicalProduct {
  if (!row.sku) throw new MappingError('Product', row.id, 'missing required field "sku"');
  return {
    sku: row.sku,
    name: row.product_name,
    category: row.category,
    reorderLevel: row.reorder_level,
    active: row.active === 1,
  };
}

export function mapInventory(row: InventoryRow): CanonicalInventory {
  if (!row.sku) throw new MappingError('Inventory', row.id, 'missing required field "sku"');
  if (!row.location) throw new MappingError('Inventory', row.sku, 'missing required field "location"');

  return {
    sku: row.sku,
    locationId: row.location,
    quantity: row.quantity,
    reservedQuantity: row.reserved_quantity,
    damagedQuantity: row.damaged_quantity,
    availableQuantity: row.quantity - row.reserved_quantity,
    lastUpdated: requireValidDate(row.last_updated, 'Inventory', `${row.sku}:${row.location}`, 'last_updated'),
  };
}

export function mapPickingTaskItem(row: PickingTaskItemRow): CanonicalPickingTaskItem {
  return {
    sku: row.sku,
    locationId: row.location,
    requestedQuantity: row.requested_quantity,
    pickedQuantity: row.picked_quantity,
    errorReason: row.error_reason,
  };
}

export function mapPickingTask(
  row: PickingTaskRow,
  itemRows: PickingTaskItemRow[],
  orderCodeById: Map<number, string>,
): CanonicalPickingTask {
  if (!row.task_id) throw new MappingError('PickingTask', row.id, 'missing required field "task_id"');
  const orderId = orderCodeById.get(row.order_id);
  if (!orderId) throw new MappingError('PickingTask', row.task_id, `no order found for internal order_id ${row.order_id}`);

  return {
    taskId: row.task_id,
    orderId,
    pickerId: row.picker_id,
    locationId: itemRows[0]?.location ?? null,
    startTime: optionalDate(row.start_time),
    endTime: optionalDate(row.end_time),
    errors: row.errors ?? 0,
    distanceWalked: row.distance_walked,
    status: toEnum<CanonicalPickingTaskStatus>(row.status, PICKING_TASK_STATUSES),
    items: itemRows.map(mapPickingTaskItem),
  };
}

export function mapPacking(row: PackingRow, orderCodeById: Map<number, string>): CanonicalPacking {
  const orderId = orderCodeById.get(row.order_id);
  if (!orderId) throw new MappingError('Packing', row.id, `no order found for internal order_id ${row.order_id}`);

  return {
    orderId,
    packingTime: requireValidDate(row.packing_time, 'Packing', orderId, 'packing_time'),
    packageSize: row.package_size,
    weight: row.weight,
    damaged: row.damaged === 1,
    packedBy: row.packed_by,
  };
}

export function mapDispatch(row: DispatchRow, orderCodeById: Map<number, string>): CanonicalDispatch {
  const orderId = orderCodeById.get(row.order_id);
  if (!orderId) throw new MappingError('Dispatch', row.id, `no order found for internal order_id ${row.order_id}`);

  return {
    orderId,
    truckId: row.truck,
    carrier: row.carrier,
    dock: row.dock,
    loadingTime: optionalDate(row.loading_time),
    departureTime: optionalDate(row.departure_time),
  };
}

export function mapReturn(row: ReturnRow, orderCodeById: Map<number, string | undefined>): CanonicalReturn {
  if (!row.return_id) throw new MappingError('Return', row.id, 'missing required field "return_id"');
  if (!row.sku) throw new MappingError('Return', row.return_id, 'missing required field "sku"');

  return {
    returnId: row.return_id,
    orderId: (row.order_id != null ? orderCodeById.get(row.order_id) : null) ?? null,
    sku: row.sku,
    reason: row.reason,
    condition: toEnum<CanonicalReturnCondition>(row.return_condition, RETURN_CONDITIONS),
    returnedAt: optionalDate(row.returned_at),
  };
}
