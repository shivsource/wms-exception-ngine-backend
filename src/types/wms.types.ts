/**
 * Row shapes mirroring the existing, already-populated WMS tables in `dummyw_data`.
 * These tables are owned by the WMS and must never be created/altered/migrated here —
 * types are hand-written from introspection (DESCRIBE) and kept in sync manually.
 */

export interface ProductRow {
  id: number;
  sku: string;
  product_name: string;
  category: string | null;
  unit_weight: number | null;
  unit_length: number | null;
  unit_width: number | null;
  unit_height: number | null;
  reorder_level: number | null;
  active: number; // tinyint(1): 0 | 1
  created_at: Date;
}

export interface InventoryRow {
  id: number;
  sku: string;
  location: string;
  quantity: number;
  reserved_quantity: number;
  damaged_quantity: number;
  last_updated: Date;
}

export type OrderPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type OrderStatus =
  | 'RECEIVED'
  | 'ALLOCATED'
  | 'PICKING'
  | 'PACKING'
  | 'READY_TO_DISPATCH'
  | 'DISPATCHED'
  | 'CANCELLED'
  | 'ON_HOLD';

export interface OrderRow {
  id: number;
  order_id: string;
  customer_id: string;
  priority: OrderPriority | null;
  order_time: Date;
  expected_dispatch: Date;
  status: OrderStatus | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderItemRow {
  id: number;
  order_id: number;
  sku: string;
  quantity: number;
  picked_quantity: number | null;
  packed_quantity: number | null;
}

export type PickingTaskStatus =
  | 'PENDING'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface PickingTaskRow {
  id: number;
  task_id: string;
  order_id: number;
  picker_id: string;
  start_time: Date | null;
  end_time: Date | null;
  errors: number | null;
  distance_walked: number | null;
  status: PickingTaskStatus | null;
}

export interface PickingTaskItemRow {
  id: number;
  task_id: number;
  sku: string;
  location: string;
  requested_quantity: number;
  picked_quantity: number | null;
  error_reason: string | null;
}

export interface PackingRow {
  id: number;
  order_id: number;
  packing_time: Date;
  package_size: string | null;
  weight: number | null;
  damaged: number | null; // tinyint(1): 0 | 1
  packed_by: string;
}

export interface DispatchRow {
  id: number;
  order_id: number;
  truck: string | null;
  carrier: string | null;
  dock: string | null;
  loading_time: Date | null;
  departure_time: Date | null;
}

export type ReturnCondition = 'NEW' | 'GOOD' | 'DAMAGED' | 'DEFECTIVE' | 'USED' | 'UNKNOWN';

export interface ReturnRow {
  id: number;
  return_id: string;
  order_id: number | null;
  sku: string;
  reason: string;
  return_condition: ReturnCondition | null;
  photos: string | null;
  returned_at: Date | null;
}
