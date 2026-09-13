import { LogisticsDataSource } from '../../canonical/logistics-data-source';
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
} from '../../canonical/types';

export interface MockLogisticsDataSourceSeed {
  orders?: CanonicalOrder[];
  products?: CanonicalProduct[];
  inventory?: CanonicalInventory[];
  pickingTasks?: CanonicalPickingTask[];
  packing?: CanonicalPacking[];
  dispatch?: CanonicalDispatch[];
  returns?: CanonicalReturn[];
}

/**
 * A LogisticsDataSource implementation that knows nothing about any database, schema,
 * or source system — it serves canonical entities handed to it directly. This is the
 * proof that the intelligence layer (rules, evidence collectors, root-cause analyzers)
 * depends only on the canonical model and the LogisticsDataSource interface, never on
 * the WMS database. See ARCHITECTURE.md and the "MostImportantArchitecturalTest" suite.
 *
 * Filtering here intentionally mirrors WmsDatabaseAdapter's filter semantics (structural
 * scoping only — status/sku/time window/id) so both implementations are interchangeable
 * from the intelligence layer's point of view.
 */
export class MockLogisticsDataSource implements LogisticsDataSource {
  readonly sourceId = 'mock';

  private orders: CanonicalOrder[];
  private products: CanonicalProduct[];
  private inventory: CanonicalInventory[];
  private pickingTasks: CanonicalPickingTask[];
  private packing: CanonicalPacking[];
  private dispatch: CanonicalDispatch[];
  private returns: CanonicalReturn[];

  constructor(seed: MockLogisticsDataSourceSeed = {}) {
    this.orders = seed.orders ?? [];
    this.products = seed.products ?? [];
    this.inventory = seed.inventory ?? [];
    this.pickingTasks = seed.pickingTasks ?? [];
    this.packing = seed.packing ?? [];
    this.dispatch = seed.dispatch ?? [];
    this.returns = seed.returns ?? [];
  }

  /** Replaces the seed data wholesale — handy for reusing one instance across test cases. */
  seed(seed: MockLogisticsDataSourceSeed): void {
    if (seed.orders) this.orders = seed.orders;
    if (seed.products) this.products = seed.products;
    if (seed.inventory) this.inventory = seed.inventory;
    if (seed.pickingTasks) this.pickingTasks = seed.pickingTasks;
    if (seed.packing) this.packing = seed.packing;
    if (seed.dispatch) this.dispatch = seed.dispatch;
    if (seed.returns) this.returns = seed.returns;
  }

  async getOrders(filter: OrderFilter = {}): Promise<CanonicalOrder[]> {
    return this.orders.filter((order) => {
      if (filter.status && (!order.status || !filter.status.includes(order.status))) return false;
      if (filter.excludeStatus && order.status && filter.excludeStatus.includes(order.status)) return false;
      if (filter.orderTimeFrom && order.orderTime < filter.orderTimeFrom) return false;
      return true;
    });
  }

  async getOrderById(orderId: string): Promise<CanonicalOrder | null> {
    return this.orders.find((o) => o.orderId === orderId) ?? null;
  }

  async getProducts(): Promise<CanonicalProduct[]> {
    return this.products;
  }

  async getProductBySku(sku: string): Promise<CanonicalProduct | null> {
    return this.products.find((p) => p.sku === sku) ?? null;
  }

  async getInventory(filter: InventoryFilter = {}): Promise<CanonicalInventory[]> {
    return this.inventory.filter((inv) => !filter.sku || inv.sku === filter.sku);
  }

  async getPickingTasks(filter: PickingTaskFilter = {}): Promise<CanonicalPickingTask[]> {
    return this.pickingTasks.filter((task) => {
      if (filter.status && (!task.status || !filter.status.includes(task.status))) return false;
      if (filter.pickerId && task.pickerId !== filter.pickerId) return false;
      return true;
    });
  }

  async getPickingTaskById(taskId: string): Promise<CanonicalPickingTask | null> {
    return this.pickingTasks.find((t) => t.taskId === taskId) ?? null;
  }

  async getPacking(filter: PackingFilter = {}): Promise<CanonicalPacking[]> {
    return this.packing.filter((p) => !filter.orderId || p.orderId === filter.orderId);
  }

  async getDispatch(filter: DispatchFilter = {}): Promise<CanonicalDispatch[]> {
    return this.dispatch.filter((d) => {
      if (filter.orderId && d.orderId !== filter.orderId) return false;
      if (filter.dock && d.dock !== filter.dock) return false;
      if (filter.departed === true && !d.departureTime) return false;
      if (filter.departed === false && d.departureTime) return false;
      return true;
    });
  }

  async getReturns(filter: ReturnFilter = {}): Promise<CanonicalReturn[]> {
    return this.returns.filter((r) => {
      if (filter.sku && r.sku !== filter.sku) return false;
      if (filter.returnedFrom && (!r.returnedAt || r.returnedAt < filter.returnedFrom)) return false;
      return true;
    });
  }
}
