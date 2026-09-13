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
import {
  dispatchRepository,
  inventoryRepository,
  orderItemRepository,
  orderRepository,
  packingRepository,
  pickingTaskItemRepository,
  pickingTaskRepository,
  productRepository,
  returnRepository,
} from '../../repositories';
import { OrderItemRow, OrderRow, PickingTaskItemRow, PickingTaskStatus } from '../../types/wms.types';
import { logger } from '../../utils/logger';
import {
  mapDispatch,
  mapInventory,
  mapOrder,
  mapPacking,
  mapPickingTask,
  mapProduct,
  mapReturn,
} from './mappers';

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = map.get(k);
    if (group) group.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/**
 * Maps each row to canonical form, skipping (and logging) any row that fails mapping
 * instead of letting one malformed record corrupt or abort the whole fetch — see
 * "Error handling" in ARCHITECTURE.md.
 */
function mapRows<TRow, TCanonical>(
  sourceId: string,
  entity: string,
  rows: TRow[],
  mapFn: (row: TRow) => TCanonical,
): TCanonical[] {
  const mapped: TCanonical[] = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      mapped.push(mapFn(row));
    } catch (error) {
      skipped++;
      logger.warn(`Skipped malformed ${entity} record`, {
        source: sourceId,
        entity,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('Normalization completed', {
    source: sourceId,
    entity,
    recordsFetched: rows.length,
    recordsNormalized: mapped.length,
    recordsSkipped: skipped,
  });
  return mapped;
}

/**
 * The first (and reference) LogisticsDataSource implementation, adapting the existing
 * WMS MySQL database. Owns all knowledge of that schema: it reads via the existing
 * repositories (unchanged), then maps + validates rows into canonical entities. It
 * contains no business/classification logic — see ARCHITECTURE.md.
 */
export class WmsDatabaseAdapter implements LogisticsDataSource {
  readonly sourceId = 'wms_database';

  /** Every order, indexed both ways — the join key every other entity needs to reach a canonical (string) orderId. */
  private async loadOrderIndex(): Promise<{ orders: OrderRow[]; orderCodeById: Map<number, string> }> {
    const orders = await orderRepository.findAll();
    logger.info('Source fetch', { source: this.sourceId, entity: 'orders', recordsFetched: orders.length });
    return { orders, orderCodeById: new Map(orders.map((o) => [o.id, o.order_id])) };
  }

  async getOrders(filter: OrderFilter = {}): Promise<CanonicalOrder[]> {
    const [{ orders }, itemRows] = await Promise.all([this.loadOrderIndex(), orderItemRepository.findAll()]);
    logger.info('Source fetch', { source: this.sourceId, entity: 'order_items', recordsFetched: itemRows.length });

    const itemsByOrderId = groupBy(itemRows, (item: OrderItemRow) => item.order_id);
    const canonical = mapRows(this.sourceId, 'orders', orders, (row) => mapOrder(row, itemsByOrderId.get(row.id) ?? []));

    return canonical.filter((order) => {
      if (filter.status && (!order.status || !filter.status.includes(order.status))) return false;
      if (filter.excludeStatus && order.status && filter.excludeStatus.includes(order.status)) return false;
      if (filter.orderTimeFrom && order.orderTime < filter.orderTimeFrom) return false;
      return true;
    });
  }

  async getOrderById(orderId: string): Promise<CanonicalOrder | null> {
    const row = await orderRepository.findByOrderCode(orderId);
    if (!row) return null;
    const items = await orderItemRepository.findByOrderId(row.id);
    try {
      return mapOrder(row, items);
    } catch (error) {
      logger.warn('Skipped malformed order record', {
        source: this.sourceId,
        entity: 'orders',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getProducts(): Promise<CanonicalProduct[]> {
    const rows = await productRepository.findAll();
    logger.info('Source fetch', { source: this.sourceId, entity: 'products', recordsFetched: rows.length });
    return mapRows(this.sourceId, 'products', rows, mapProduct);
  }

  async getProductBySku(sku: string): Promise<CanonicalProduct | null> {
    const row = await productRepository.findBySku(sku);
    if (!row) return null;
    try {
      return mapProduct(row);
    } catch (error) {
      logger.warn('Skipped malformed product record', {
        source: this.sourceId,
        entity: 'products',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getInventory(filter: InventoryFilter = {}): Promise<CanonicalInventory[]> {
    const rows = filter.sku ? await inventoryRepository.findBySku(filter.sku) : await inventoryRepository.findAll();
    logger.info('Source fetch', { source: this.sourceId, entity: 'inventory', recordsFetched: rows.length });
    return mapRows(this.sourceId, 'inventory', rows, mapInventory);
  }

  async getPickingTasks(filter: PickingTaskFilter = {}): Promise<CanonicalPickingTask[]> {
    const [{ orderCodeById }, taskRows, itemRows] = await Promise.all([
      this.loadOrderIndex(),
      pickingTaskRepository.findAll(filter.status ? { status: filter.status as unknown as PickingTaskStatus[] } : {}),
      pickingTaskItemRepository.findAll(),
    ]);
    logger.info('Source fetch', { source: this.sourceId, entity: 'picking_tasks', recordsFetched: taskRows.length });
    logger.info('Source fetch', { source: this.sourceId, entity: 'picking_task_items', recordsFetched: itemRows.length });

    const itemsByTaskId = groupBy(itemRows, (item: PickingTaskItemRow) => item.task_id);
    const canonical = mapRows(this.sourceId, 'picking_tasks', taskRows, (row) =>
      mapPickingTask(row, itemsByTaskId.get(row.id) ?? [], orderCodeById),
    );

    return canonical.filter((task) => !filter.pickerId || task.pickerId === filter.pickerId);
  }

  async getPickingTaskById(taskId: string): Promise<CanonicalPickingTask | null> {
    const [row, { orderCodeById }] = await Promise.all([
      pickingTaskRepository.findByTaskCode(taskId),
      this.loadOrderIndex(),
    ]);
    if (!row) return null;
    const items = await pickingTaskItemRepository.findByTaskId(row.id);
    try {
      return mapPickingTask(row, items, orderCodeById);
    } catch (error) {
      logger.warn('Skipped malformed picking task record', {
        source: this.sourceId,
        entity: 'picking_tasks',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getPacking(filter: PackingFilter = {}): Promise<CanonicalPacking[]> {
    const { orderCodeById, orders } = await this.loadOrderIndex();
    let rows;
    if (filter.orderId) {
      const orderRow = orders.find((o) => o.order_id === filter.orderId);
      rows = orderRow ? await packingRepository.findByOrderId(orderRow.id) : [];
    } else {
      rows = await packingRepository.findAll();
    }
    logger.info('Source fetch', { source: this.sourceId, entity: 'packing', recordsFetched: rows.length });
    return mapRows(this.sourceId, 'packing', rows, (row) => mapPacking(row, orderCodeById));
  }

  async getDispatch(filter: DispatchFilter = {}): Promise<CanonicalDispatch[]> {
    const { orderCodeById, orders } = await this.loadOrderIndex();
    let rows;
    if (filter.orderId) {
      const orderRow = orders.find((o) => o.order_id === filter.orderId);
      rows = orderRow ? await dispatchRepository.findByOrderId(orderRow.id) : [];
    } else {
      const dispatchFilter: { dock?: string; departed?: boolean } = {};
      if (filter.dock !== undefined) dispatchFilter.dock = filter.dock;
      if (filter.departed !== undefined) dispatchFilter.departed = filter.departed;
      rows = await dispatchRepository.findAll(dispatchFilter);
    }
    logger.info('Source fetch', { source: this.sourceId, entity: 'dispatch', recordsFetched: rows.length });
    return mapRows(this.sourceId, 'dispatch', rows, (row) => mapDispatch(row, orderCodeById));
  }

  async getReturns(filter: ReturnFilter = {}): Promise<CanonicalReturn[]> {
    const returnFilter: { sku?: string; returnedFrom?: Date } = {};
    if (filter.sku !== undefined) returnFilter.sku = filter.sku;
    if (filter.returnedFrom !== undefined) returnFilter.returnedFrom = filter.returnedFrom;
    const [{ orderCodeById }, rows] = await Promise.all([this.loadOrderIndex(), returnRepository.findAll(returnFilter)]);
    logger.info('Source fetch', { source: this.sourceId, entity: 'returns', recordsFetched: rows.length });
    return mapRows(this.sourceId, 'returns', rows, (row) => mapReturn(row, orderCodeById));
  }
}
