import {
  CanonicalDispatch,
  CanonicalInventory,
  CanonicalOrder,
  CanonicalPacking,
  CanonicalPickingTask,
  CanonicalProduct,
  CanonicalReturn,
  DispatchFilter,
  InventoryFilter,
  OrderFilter,
  PackingFilter,
  PickingTaskFilter,
  ReturnFilter,
} from './types';

/**
 * The single boundary between the intelligence layer (rules, evidence collectors,
 * root-cause analyzers) and every possible source system. An implementation knows how
 * to talk to one source (a WMS database, a TMS API, a CSV/SFTP drop, ...) and returns
 * only canonical entities — the intelligence layer never sees source-specific rows,
 * SQL, or identifiers.
 *
 * Every method is a bulk/lookup fetch, scoped only by structural filters (status, sku,
 * time window, id). Business classification (thresholds, severities, "is this a
 * shortage") never belongs in an implementation of this interface — see src/queries/
 * and ARCHITECTURE.md.
 */
export interface LogisticsDataSource {
  /** Stable identifier for this source, used in config and structured logs (e.g. "wms_database", "mock"). */
  readonly sourceId: string;

  getOrders(filter?: OrderFilter): Promise<CanonicalOrder[]>;
  getOrderById(orderId: string): Promise<CanonicalOrder | null>;

  getProducts(): Promise<CanonicalProduct[]>;
  getProductBySku(sku: string): Promise<CanonicalProduct | null>;

  getInventory(filter?: InventoryFilter): Promise<CanonicalInventory[]>;

  getPickingTasks(filter?: PickingTaskFilter): Promise<CanonicalPickingTask[]>;
  getPickingTaskById(taskId: string): Promise<CanonicalPickingTask | null>;

  getPacking(filter?: PackingFilter): Promise<CanonicalPacking[]>;

  getDispatch(filter?: DispatchFilter): Promise<CanonicalDispatch[]>;

  getReturns(filter?: ReturnFilter): Promise<CanonicalReturn[]>;
}
