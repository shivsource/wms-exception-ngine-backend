import { describe, expect, it } from 'vitest';
import { DispatchRow, InventoryRow, OrderItemRow, OrderRow, PickingTaskItemRow, PickingTaskRow } from '../../types/wms.types';
import { MappingError, mapDispatch, mapInventory, mapOrder, mapPickingTask } from './mappers';

const ORDER_ROW: OrderRow = {
  id: 7,
  order_id: 'ORD-100160',
  customer_id: 'CUST-42',
  priority: 'HIGH',
  order_time: new Date('2026-08-20T08:00:00.000Z'),
  expected_dispatch: new Date('2026-08-20T12:00:00.000Z'),
  status: 'PICKING',
  created_at: new Date('2026-08-20T08:00:00.000Z'),
  updated_at: new Date('2026-08-20T08:00:00.000Z'),
};

const ORDER_ITEM_ROWS: OrderItemRow[] = [
  { id: 1, order_id: 7, sku: 'SKU-1', quantity: 5, picked_quantity: 2, packed_quantity: 0 },
];

const INVENTORY_ROW: InventoryRow = {
  id: 1,
  sku: 'SKU-1',
  location: 'A-17',
  quantity: 50,
  reserved_quantity: 10,
  damaged_quantity: 2,
  last_updated: new Date('2026-08-20T07:00:00.000Z'),
};

describe('WMS row -> canonical mapping (TEST 1-3)', () => {
  it('1. maps an orders row + its order_items into a CanonicalOrder', () => {
    const canonical = mapOrder(ORDER_ROW, ORDER_ITEM_ROWS);

    expect(canonical).toEqual({
      orderId: 'ORD-100160',
      customerId: 'CUST-42',
      priority: 'HIGH',
      orderTime: new Date('2026-08-20T08:00:00.000Z'),
      expectedDispatchTime: new Date('2026-08-20T12:00:00.000Z'),
      status: 'PICKING',
      items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 2, packedQuantity: 0 }],
    });
  });

  it('2. maps an inventory row into a CanonicalInventory, computing availableQuantity', () => {
    const canonical = mapInventory(INVENTORY_ROW);

    expect(canonical).toEqual({
      sku: 'SKU-1',
      locationId: 'A-17',
      quantity: 50,
      reservedQuantity: 10,
      damagedQuantity: 2,
      availableQuantity: 40, // 50 - 10
      lastUpdated: new Date('2026-08-20T07:00:00.000Z'),
    });
  });

  it('3. maps a picking_tasks row + its items into a CanonicalPickingTask, resolving orderId via the order index', () => {
    const taskRow: PickingTaskRow = {
      id: 1,
      task_id: 'TASK-100',
      order_id: 7,
      picker_id: 'PICKER-3',
      start_time: new Date('2026-08-20T08:30:00.000Z'),
      end_time: null,
      errors: 0,
      distance_walked: 120.5,
      status: 'IN_PROGRESS',
    };
    const itemRows: PickingTaskItemRow[] = [
      { id: 1, task_id: 1, sku: 'SKU-1', location: 'A-17', requested_quantity: 5, picked_quantity: 2, error_reason: null },
    ];
    const orderCodeById = new Map([[7, 'ORD-100160']]);

    const canonical = mapPickingTask(taskRow, itemRows, orderCodeById);

    expect(canonical).toEqual({
      taskId: 'TASK-100',
      orderId: 'ORD-100160',
      pickerId: 'PICKER-3',
      locationId: 'A-17',
      startTime: new Date('2026-08-20T08:30:00.000Z'),
      endTime: null,
      errors: 0,
      distanceWalked: 120.5,
      status: 'IN_PROGRESS',
      items: [{ sku: 'SKU-1', locationId: 'A-17', requestedQuantity: 5, pickedQuantity: 2, errorReason: null }],
    });
  });

  it('rejects a malformed order row (missing order_time) instead of producing corrupt canonical data', () => {
    const malformed: OrderRow = { ...ORDER_ROW, order_time: null as unknown as Date };
    expect(() => mapOrder(malformed, [])).toThrow(MappingError);
  });

  it('rejects an inventory row missing its required sku', () => {
    const malformed: InventoryRow = { ...INVENTORY_ROW, sku: '' };
    expect(() => mapInventory(malformed)).toThrow(MappingError);
  });

  it('rejects a picking task row whose order_id has no matching order (dangling FK)', () => {
    const taskRow: PickingTaskRow = {
      id: 1,
      task_id: 'TASK-999',
      order_id: 999,
      picker_id: 'PICKER-3',
      start_time: null,
      end_time: null,
      errors: 0,
      distance_walked: null,
      status: 'PENDING',
    };
    expect(() => mapPickingTask(taskRow, [], new Map())).toThrow(MappingError);
  });

  it('degrades an unrecognized status value to null instead of throwing', () => {
    const canonical = mapOrder({ ...ORDER_ROW, status: 'SOME_FUTURE_STATUS' as unknown as OrderRow['status'] }, []);
    expect(canonical.status).toBeNull();
  });

  it('maps a dispatch row with null loading/departure timestamps', () => {
    const dispatchRow: DispatchRow = {
      id: 1,
      order_id: 7,
      truck: 'TRUCK-1',
      carrier: 'Carrier Co',
      dock: 'DOCK-1',
      loading_time: null,
      departure_time: null,
    };
    const canonical = mapDispatch(dispatchRow, new Map([[7, 'ORD-100160']]));

    expect(canonical).toEqual({
      orderId: 'ORD-100160',
      truckId: 'TRUCK-1',
      carrier: 'Carrier Co',
      dock: 'DOCK-1',
      loadingTime: null,
      departureTime: null,
    });
  });
});
