import { PersistedException } from './persisted-exception.interface';

/**
 * Structured evidence shapes returned by each EvidenceCollector (src/evidence/) and
 * consumed by the matching ExplanationGenerator (src/explanations/). One section per
 * exception type, plus shared shapes reused across several of them (orders, picking
 * task items) to avoid re-declaring the same fields nine times.
 */

// ---- Shared shapes ------------------------------------------------------

/** Parent order context, reused by every collector whose exception hangs off an order. */
export interface OrderContext {
  orderId: string;
  customerId: string;
  priority: string | null;
  expectedDispatch: Date;
  status: string | null;
}

/** A picking_task_items row enriched with its product's display name and pending count. */
export interface PickingTaskItemContext {
  sku: string;
  productName: string | null;
  location: string;
  requestedQuantity: number;
  pickedQuantity: number | null;
  pending: number;
}

/** An order_items row enriched with its product's display name — used for order-level (not task-level) progress. */
export interface OrderItemProgress {
  sku: string;
  productName: string | null;
  orderedQuantity: number;
  pickedQuantity: number | null;
  packedQuantity: number | null;
}

// ---- PICKING_DELAY --------------------------------------------------------

export interface PickingDelayEvidence {
  task: {
    /** The task's business code (e.g. "TASK-100") — same value as taskCode, kept as `id` for shape stability. */
    id: string;
    taskCode: string;
    pickerId: string;
    startTime: Date;
    elapsedMinutes: number;
  };
  order: OrderContext | null;
  items: PickingTaskItemContext[];
  baseline: {
    avgCompletedMinutes: number;
    delayRatio: number | null;
  };
}

// ---- PICKING_ERROR ---------------------------------------------------------

export interface PickingErrorEvidenceItem {
  sku: string;
  productName: string | null;
  location: string;
  requestedQuantity: number;
  pickedQuantity: number | null;
  errorReason: string;
}

export interface PickingErrorEvidence {
  task: {
    /** The task's business code (e.g. "TASK-100") — same value as taskCode, kept as `id` for shape stability. */
    id: string;
    taskCode: string;
    pickerId: string;
    status: string | null;
    startTime: Date | null;
    endTime: Date | null;
  };
  order: OrderContext | null;
  errorCount: number;
  errors: PickingErrorEvidenceItem[];
}

// ---- EXCESSIVE_PICKING_TIME -------------------------------------------------

export interface ExcessivePickingTimeEvidence {
  task: {
    /** The task's business code (e.g. "TASK-100") — same value as taskCode, kept as `id` for shape stability. */
    id: string;
    taskCode: string;
    pickerId: string;
    pickingMinutes: number;
    warehouseAverageMinutes: number;
    ratio: number;
  };
  order: OrderContext | null;
  items: PickingTaskItemContext[];
}

// ---- EXCESSIVE_PICKER_DISTANCE ----------------------------------------------

export interface ExcessivePickerDistanceEvidence {
  task: {
    /** The task's business code (e.g. "TASK-100") — same value as taskCode, kept as `id` for shape stability. */
    id: string;
    taskCode: string;
    pickerId: string;
    distanceWalked: number;
    warehouseAverageDistance: number;
    ratio: number;
  };
  order: OrderContext | null;
  items: PickingTaskItemContext[];
}

// ---- SLA_AT_RISK -------------------------------------------------------------

export interface SlaAtRiskEvidence {
  order: (OrderContext & { orderTime: Date; minutesRemaining: number; breached: boolean }) | null;
  items: OrderItemProgress[];
}

// ---- PACKING_DELAY --------------------------------------------------------

export interface PackingDelayEvidence {
  order: OrderContext | null;
  lastPickingCompletedAt: Date;
  minutesWaiting: number;
  items: OrderItemProgress[];
}

// ---- DISPATCH_DELAY -------------------------------------------------------

export interface DispatchDelayEvidence {
  order: OrderContext | null;
  packing: {
    packingTime: Date;
    packageSize: string | null;
    weight: number | null;
    damaged: boolean;
    packedBy: string;
  } | null;
  minutesWaiting: number;
}

// ---- HIGH_RETURN_RATE -----------------------------------------------------

export interface RecentReturn {
  returnId: string;
  reason: string;
  condition: string | null;
  returnedAt: Date | null;
}

export interface HighReturnRateEvidence {
  product: { sku: string; productName: string | null; category: string | null };
  totalReturned: number;
  totalOrdered: number;
  returnRatePercentage: number;
  windowDays: number;
  recentReturns: RecentReturn[];
}

// ---- INVENTORY_SHORTAGE ---------------------------------------------------

export interface InventoryLocationBreakdown {
  location: string;
  quantity: number;
  reservedQuantity: number;
  damagedQuantity: number;
  lastUpdated: Date;
}

export interface InventoryShortageEvidence {
  product: { sku: string; productName: string | null; category: string | null; reorderLevel: number | null };
  totals: {
    totalQuantity: number;
    totalReserved: number;
    totalAvailable: number;
    shortfallUnits: number;
    shortfallPercentage: number;
  };
  locations: InventoryLocationBreakdown[];
}

// ---- INVENTORY_DISCREPANCY --------------------------------------------------

export interface InventoryDiscrepancyEvidence {
  product: { sku: string; productName: string | null; category: string | null };
  discrepancy: {
    location: string;
    quantity: number;
    reservedQuantity: number;
    damagedQuantity: number;
    lastUpdated: Date;
  };
  /** Every location this SKU is stocked at, for context on whether the mismatch is isolated. */
  locations: InventoryLocationBreakdown[];
}

// ---- API-facing wrapper -----------------------------------------------------

/** A persisted exception augmented with structured evidence and a human-readable explanation. */
export interface EnrichedException extends PersistedException {
  structuredEvidence: Record<string, unknown> | null;
  explanation: string;
}
