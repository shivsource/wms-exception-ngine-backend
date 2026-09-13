/**
 * Canonical logistics domain model — the ONLY shapes the intelligence layer (rules,
 * evidence collectors, root-cause analyzers) is allowed to depend on.
 *
 * These are business concepts (order, inventory position, picking task, ...), not a copy
 * of any single source system's tables. A field only belongs here if a current exception
 * type, evidence collector, or root-cause analyzer actually uses it. Every identifier is
 * a business/human-readable code (e.g. "ORD-100160", "TASK-100") — never a source
 * system's internal autoincrement id — so a source with no such id (an API, a CSV feed)
 * can still be mapped into this model.
 */

export type CanonicalOrderPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export type CanonicalOrderStatus =
  | 'RECEIVED'
  | 'ALLOCATED'
  | 'PICKING'
  | 'PACKING'
  | 'READY_TO_DISPATCH'
  | 'DISPATCHED'
  | 'CANCELLED'
  | 'ON_HOLD';

export interface CanonicalOrderItem {
  sku: string;
  orderedQuantity: number;
  pickedQuantity: number | null;
  packedQuantity: number | null;
}

export interface CanonicalOrder {
  orderId: string;
  customerId: string;
  priority: CanonicalOrderPriority | null;
  orderTime: Date;
  expectedDispatchTime: Date;
  status: CanonicalOrderStatus | null;
  items: CanonicalOrderItem[];
}

export interface CanonicalProduct {
  sku: string;
  name: string;
  category: string | null;
  reorderLevel: number | null;
  active: boolean;
}

export interface CanonicalInventory {
  sku: string;
  locationId: string;
  quantity: number;
  reservedQuantity: number;
  damagedQuantity: number;
  availableQuantity: number;
  lastUpdated: Date;
}

export type CanonicalPickingTaskStatus =
  | 'PENDING'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface CanonicalPickingTaskItem {
  sku: string;
  locationId: string;
  requestedQuantity: number;
  pickedQuantity: number | null;
  errorReason: string | null;
}

export interface CanonicalPickingTask {
  taskId: string;
  orderId: string;
  pickerId: string;
  locationId: string | null;
  startTime: Date | null;
  endTime: Date | null;
  errors: number;
  distanceWalked: number | null;
  status: CanonicalPickingTaskStatus | null;
  items: CanonicalPickingTaskItem[];
}

export interface CanonicalPacking {
  orderId: string;
  packingTime: Date;
  packageSize: string | null;
  weight: number | null;
  damaged: boolean;
  packedBy: string;
}

export interface CanonicalDispatch {
  orderId: string;
  truckId: string | null;
  carrier: string | null;
  dock: string | null;
  loadingTime: Date | null;
  departureTime: Date | null;
}

export type CanonicalReturnCondition = 'NEW' | 'GOOD' | 'DAMAGED' | 'DEFECTIVE' | 'USED' | 'UNKNOWN';

export interface CanonicalReturn {
  returnId: string;
  orderId: string | null;
  sku: string;
  reason: string;
  condition: CanonicalReturnCondition | null;
  returnedAt: Date | null;
}

// ---- Fetch filters --------------------------------------------------------
// Deliberately structural/scoping only (time windows, status, sku, id) — never a
// business threshold or classification. Classification stays in src/queries/ and the
// rules/analyzers themselves; see ARCHITECTURE.md.

export interface OrderFilter {
  status?: CanonicalOrderStatus[];
  excludeStatus?: CanonicalOrderStatus[];
  orderTimeFrom?: Date;
}

export interface InventoryFilter {
  sku?: string;
}

export interface PickingTaskFilter {
  status?: CanonicalPickingTaskStatus[];
  pickerId?: string;
}

export interface PackingFilter {
  orderId?: string;
}

export interface DispatchFilter {
  orderId?: string;
  dock?: string;
  /** true = only records with no departureTime yet; false = only departed; omitted = all. */
  departed?: boolean;
}

export interface ReturnFilter {
  sku?: string;
  returnedFrom?: Date;
}
