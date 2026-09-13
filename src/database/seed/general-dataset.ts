import { Pool } from 'mysql2/promise';
import { Rng } from './rng';
import { addMinutes, toSql } from './time';
import { bulkInsert, loadCodeToIdMap } from './insert-helpers';
import { CARRIERS, dockCode, locationCode, PACKAGE_SIZES, PRODUCT_TEMPLATES, RETURN_REASONS, truckCode } from './pools';

/**
 * The general (non-controlled) operational dataset — everything EXCEPT the 15 VAL-* scenarios
 * in controlled-scenarios.ts. Built purely from a seeded Rng so its structure (counts,
 * archetype mix, relationships) is identical on every run; only absolute timestamps move,
 * anchored to T0 = resolveSimulationTime() (real "now" by default — see time.ts).
 *
 * Every id/quantity/duration choice below implements Steps 4-7 and 16 of the brief this was
 * built from: realistic counts, temporal consistency (child timestamps never precede parent
 * timestamps, nothing "not yet happened" is recorded as already happened), an SLA mix
 * (~75/12/8/3.5/1.5% healthy/moderate/high/critical/breached) applied only to still-open
 * orders, and a small (~15-20%), not-months-stale, percentage of already-open operational
 * risk (a task already past the stuck threshold, a SKU already short) — real warehouses
 * always have *some* current exceptions; the bug this reset fixes was ALL of them being
 * months old, not that a few exist.
 */

type OrderStatus = 'RECEIVED' | 'ALLOCATED' | 'PICKING' | 'PACKING' | 'READY_TO_DISPATCH' | 'DISPATCHED' | 'CANCELLED' | 'ON_HOLD';

interface GenOrderItem {
  sku: string;
  quantity: number;
  pickedQuantity: number;
  packedQuantity: number;
}
interface GenPickingTaskItem {
  sku: string;
  location: string;
  requestedQuantity: number;
  pickedQuantity: number;
  errorReason: string | null;
}
interface GenPickingTask {
  taskId: string;
  pickerId: string;
  startTime: Date | null;
  endTime: Date | null;
  errors: number;
  distanceWalked: number | null;
  status: string;
  items: GenPickingTaskItem[];
}
interface GenPacking {
  packingTime: Date;
  packageSize: string;
  weight: number;
  damaged: boolean;
  packedBy: string;
}
interface GenDispatch {
  truck: string | null;
  carrier: string | null;
  dock: string | null;
  loadingTime: Date | null;
  departureTime: Date | null;
}
interface GenOrder {
  orderId: string;
  customerId: string;
  priority: string;
  orderTime: Date;
  expectedDispatch: Date;
  status: OrderStatus;
  items: GenOrderItem[];
  pickingTasks: GenPickingTask[];
  packing: GenPacking | null;
  dispatch: GenDispatch | null;
}

const CUSTOMER_COUNT = 130;
const PRODUCT_COUNT = 150;
const PICKER_COUNT = 60;
const PACKER_COUNT = 35;

let orderSeq = 200001;
let taskSeq = 600001;
let returnSeq = 700001;

function nextOrderId(): string {
  return `ORD-${orderSeq++}`;
}
function nextTaskId(): string {
  return `PICK-${taskSeq++}`;
}
function nextReturnId(): string {
  return `RET-${returnSeq++}`;
}

function pickDurationMinutes(rng: Rng): number {
  // A small tail of slow outliers, deliberately, to give ExcessivePickingTimeRule real
  // (small, not-months-stale) findings — see Step 7.N.
  if (rng.chance(0.05)) return rng.int(60, 130);
  return rng.int(15, 40);
}
function distanceWalkedMeters(rng: Rng): number {
  if (rng.chance(0.04)) return rng.int(1500, 3000);
  return rng.int(200, 900);
}
function pickErrors(rng: Rng): number {
  if (rng.chance(0.03)) return rng.int(3, 5);
  if (rng.chance(0.07)) return rng.int(1, 2);
  return 0;
}

function assignPriority(rng: Rng): string {
  return rng.weighted([
    ['LOW', 15],
    ['NORMAL', 55],
    ['HIGH', 20],
    ['URGENT', 10],
  ]);
}

/** Step 6's SLA distribution — applies only to orders that are still open (not DISPATCHED/CANCELLED). */
function assignSlaMinutesRemaining(rng: Rng): number {
  const bucket = rng.weighted([
    ['healthy', 75],
    ['moderate', 12],
    ['high', 8],
    ['critical', 3.5],
    ['breached', 1.5],
  ] as const);
  switch (bucket) {
    case 'healthy':
      return rng.int(121, 600);
    case 'moderate':
      return rng.int(46, 120);
    case 'high':
      return rng.int(16, 45);
    case 'critical':
      return rng.int(1, 15);
    case 'breached':
      return -rng.int(1, 60);
  }
}

interface Catalog {
  skus: string[];
  reorderLevelBySku: Map<string, number>;
}

function pickOrderItems(rng: Rng, catalog: Catalog, count: number): { sku: string; quantity: number }[] {
  const chosen = rng.shuffle(catalog.skus).slice(0, count);
  return chosen.map((sku) => ({ sku, quantity: rng.int(1, 6) }));
}

function buildPickingTaskFromItems(
  rng: Rng,
  pickerId: string,
  items: { sku: string; quantity: number; pickedQuantity: number }[],
  status: string,
  startTime: Date | null,
  endTime: Date | null,
): GenPickingTask {
  return {
    taskId: nextTaskId(),
    pickerId,
    startTime,
    endTime,
    errors: status === 'COMPLETED' || status === 'IN_PROGRESS' ? pickErrors(rng) : 0,
    distanceWalked: status === 'COMPLETED' ? distanceWalkedMeters(rng) : status === 'IN_PROGRESS' ? distanceWalkedMeters(rng) / 2 : null,
    status,
    items: items.map((item) => ({
      sku: item.sku,
      location: locationCode(rng),
      requestedQuantity: item.quantity,
      pickedQuantity: item.pickedQuantity,
      errorReason: null,
    })),
  };
}

function buildDispatchedOrder(rng: Rng, catalog: Catalog, t0: Date, pickers: string[], packers: string[]): GenOrder {
  const orderTime = addMinutes(t0, -rng.int(1 * 24 * 60, 20 * 24 * 60));
  const itemDefs = pickOrderItems(rng, catalog, rng.int(1, 4));
  const items: GenOrderItem[] = itemDefs.map((d) => ({ sku: d.sku, quantity: d.quantity, pickedQuantity: d.quantity, packedQuantity: d.quantity }));

  const pickStart = addMinutes(orderTime, rng.int(10, 60));
  const duration = pickDurationMinutes(rng);

  const twoTasks = rng.chance(0.12) && items.length > 1;
  const pickingTasks: GenPickingTask[] = [];
  let lastPickEnd = addMinutes(pickStart, duration);
  if (twoTasks) {
    const half = Math.ceil(items.length / 2);
    const groups = [items.slice(0, half), items.slice(half)];
    let cursor = pickStart;
    for (const group of groups) {
      if (group.length === 0) continue;
      const gDuration = Math.round(duration / groups.length);
      const gEnd = addMinutes(cursor, gDuration);
      pickingTasks.push(
        buildPickingTaskFromItems(rng, rng.pick(pickers), group.map((i) => ({ ...i, pickedQuantity: i.quantity })), 'COMPLETED', cursor, gEnd),
      );
      lastPickEnd = gEnd;
      cursor = addMinutes(gEnd, 2);
    }
  } else {
    pickingTasks.push(
      buildPickingTaskFromItems(rng, rng.pick(pickers), items.map((i) => ({ ...i, pickedQuantity: i.quantity })), 'COMPLETED', pickStart, lastPickEnd),
    );
  }

  const packingTime = addMinutes(lastPickEnd, rng.int(5, 45));
  const loadingTime = addMinutes(packingTime, rng.int(10, 90));
  const departureTime = addMinutes(loadingTime, rng.int(5, 60));
  const expectedDispatch = addMinutes(orderTime, rng.int(180, 480));

  return {
    orderId: nextOrderId(),
    customerId: `CUST-${2000 + rng.int(0, CUSTOMER_COUNT - 1)}`,
    priority: assignPriority(rng),
    orderTime,
    expectedDispatch,
    status: 'DISPATCHED',
    items,
    pickingTasks,
    packing: { packingTime, packageSize: rng.pick(PACKAGE_SIZES), weight: rng.float(0.3, 8, 2), damaged: rng.chance(0.02), packedBy: rng.pick(packers) },
    dispatch: { truck: truckCode(rng, (a) => rng.pick(a)), carrier: rng.pick(CARRIERS), dock: dockCode(rng), loadingTime, departureTime },
  };
}

function buildReadyToDispatchOrder(rng: Rng, catalog: Catalog, t0: Date, pickers: string[], packers: string[]): GenOrder {
  const itemDefs = pickOrderItems(rng, catalog, rng.int(1, 4));
  const items: GenOrderItem[] = itemDefs.map((d) => ({ sku: d.sku, quantity: d.quantity, pickedQuantity: d.quantity, packedQuantity: d.quantity }));

  const minutesSincePacked = rng.chance(0.15) ? rng.int(61, 180) : rng.int(1, 55);
  const packingTime = addMinutes(t0, -minutesSincePacked);
  const pickEnd = addMinutes(packingTime, -rng.int(5, 40));
  const pickStart = addMinutes(pickEnd, -pickDurationMinutes(rng));
  const orderTime = addMinutes(pickStart, -rng.int(10, 60));
  const minutesRemaining = assignSlaMinutesRemaining(rng);

  const dispatch: GenDispatch | null = rng.chance(0.6)
    ? { truck: null, carrier: null, dock: dockCode(rng), loadingTime: addMinutes(packingTime, rng.int(5, 30)), departureTime: null }
    : null;

  return {
    orderId: nextOrderId(),
    customerId: `CUST-${2000 + rng.int(0, CUSTOMER_COUNT - 1)}`,
    priority: assignPriority(rng),
    orderTime,
    expectedDispatch: addMinutes(t0, minutesRemaining),
    status: 'READY_TO_DISPATCH',
    items,
    pickingTasks: [buildPickingTaskFromItems(rng, rng.pick(pickers), items.map((i) => ({ ...i, pickedQuantity: i.quantity })), 'COMPLETED', pickStart, pickEnd)],
    packing: { packingTime, packageSize: rng.pick(PACKAGE_SIZES), weight: rng.float(0.3, 8, 2), damaged: rng.chance(0.02), packedBy: rng.pick(packers) },
    dispatch,
  };
}

function buildPackingOrder(rng: Rng, catalog: Catalog, t0: Date, pickers: string[]): GenOrder {
  const itemDefs = pickOrderItems(rng, catalog, rng.int(1, 3));
  const items: GenOrderItem[] = itemDefs.map((d) => ({ sku: d.sku, quantity: d.quantity, pickedQuantity: d.quantity, packedQuantity: 0 }));

  const minutesSincePickEnd = rng.chance(0.15) ? rng.int(61, 150) : rng.int(2, 55);
  const pickEnd = addMinutes(t0, -minutesSincePickEnd);
  const pickStart = addMinutes(pickEnd, -pickDurationMinutes(rng));
  const orderTime = addMinutes(pickStart, -rng.int(10, 60));
  const minutesRemaining = assignSlaMinutesRemaining(rng);

  return {
    orderId: nextOrderId(),
    customerId: `CUST-${2000 + rng.int(0, CUSTOMER_COUNT - 1)}`,
    priority: assignPriority(rng),
    orderTime,
    expectedDispatch: addMinutes(t0, minutesRemaining),
    status: 'PACKING',
    items,
    pickingTasks: [buildPickingTaskFromItems(rng, rng.pick(pickers), items.map((i) => ({ ...i, pickedQuantity: i.quantity })), 'COMPLETED', pickStart, pickEnd)],
    packing: null,
    dispatch: null,
  };
}

function buildPickingOrder(rng: Rng, catalog: Catalog, t0: Date, pickers: string[]): GenOrder {
  const itemDefs = pickOrderItems(rng, catalog, rng.int(1, 3));

  const elapsed = rng.chance(0.05) ? rng.int(76, 150) : rng.chance(0.176) ? rng.int(56, 75) : rng.int(2, 55);
  const startTime = addMinutes(t0, -elapsed);
  const orderTime = addMinutes(startTime, -rng.int(10, 60));
  const minutesRemaining = assignSlaMinutesRemaining(rng);

  const items: GenOrderItem[] = itemDefs.map((d) => ({ sku: d.sku, quantity: d.quantity, pickedQuantity: rng.int(0, d.quantity), packedQuantity: 0 }));

  return {
    orderId: nextOrderId(),
    customerId: `CUST-${2000 + rng.int(0, CUSTOMER_COUNT - 1)}`,
    priority: assignPriority(rng),
    orderTime,
    expectedDispatch: addMinutes(t0, minutesRemaining),
    status: 'PICKING',
    items,
    pickingTasks: [buildPickingTaskFromItems(rng, rng.pick(pickers), items.map((i) => ({ sku: i.sku, quantity: i.quantity, pickedQuantity: i.pickedQuantity })), 'IN_PROGRESS', startTime, null)],
    packing: null,
    dispatch: null,
  };
}

function buildEarlyStageOrder(rng: Rng, catalog: Catalog, t0: Date, status: 'RECEIVED' | 'ALLOCATED' | 'ON_HOLD' | 'CANCELLED', pickers: string[]): GenOrder {
  const itemDefs = pickOrderItems(rng, catalog, rng.int(1, 3));
  const items: GenOrderItem[] = itemDefs.map((d) => ({ sku: d.sku, quantity: d.quantity, pickedQuantity: 0, packedQuantity: 0 }));

  const orderTime = addMinutes(t0, -rng.int(5, status === 'CANCELLED' ? 600 : 180));
  const minutesRemaining = status === 'CANCELLED' ? rng.int(60, 400) : assignSlaMinutesRemaining(rng);

  const pickingTasks: GenPickingTask[] = [];
  if (status === 'ALLOCATED' && rng.chance(0.5)) {
    pickingTasks.push(buildPickingTaskFromItems(rng, rng.pick(pickers), items.map((i) => ({ sku: i.sku, quantity: i.quantity, pickedQuantity: 0 })), 'ASSIGNED', null, null));
  }
  if (status === 'ON_HOLD' && rng.chance(0.3)) {
    pickingTasks.push(buildPickingTaskFromItems(rng, rng.pick(pickers), items.map((i) => ({ sku: i.sku, quantity: i.quantity, pickedQuantity: 0 })), 'PENDING', null, null));
  }
  if (status === 'CANCELLED' && rng.chance(0.2)) {
    pickingTasks.push(buildPickingTaskFromItems(rng, rng.pick(pickers), items.map((i) => ({ sku: i.sku, quantity: i.quantity, pickedQuantity: 0 })), 'CANCELLED', addMinutes(orderTime, 10), null));
  }

  return {
    orderId: nextOrderId(),
    customerId: `CUST-${2000 + rng.int(0, CUSTOMER_COUNT - 1)}`,
    priority: assignPriority(rng),
    orderTime,
    expectedDispatch: addMinutes(t0, minutesRemaining),
    status,
    items,
    pickingTasks,
    packing: null,
    dispatch: null,
  };
}

export interface GeneralDatasetSummary {
  customers: number;
  products: number;
  inventory: number;
  orders: number;
  orderItems: number;
  pickingTasks: number;
  pickingTaskItems: number;
  packing: number;
  dispatch: number;
  returns: number;
  ordersByStatus: Record<string, number>;
}

export async function seedGeneralDataset(pool: Pool, t0: Date): Promise<GeneralDatasetSummary> {
  const rng = new Rng(20260904);

  // ---- products ----
  const productRows: unknown[][] = [];
  const skus: string[] = [];
  const reorderLevelBySku = new Map<string, number>();
  let templateIdx = 0;
  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const template = PRODUCT_TEMPLATES[templateIdx % PRODUCT_TEMPLATES.length]!;
    templateIdx++;
    const variant = Math.floor(i / PRODUCT_TEMPLATES.length) + 1;
    const sku = `SKU-${2001 + i}`;
    const reorderLevel = rng.int(15, 60);
    skus.push(sku);
    reorderLevelBySku.set(sku, reorderLevel);
    productRows.push([
      sku,
      `${template.name}${variant > 1 ? ` ${variant}` : ''}`,
      template.category,
      rng.float(0.1, 5, 2),
      rng.float(5, 60, 1),
      rng.float(5, 50, 1),
      rng.float(2, 30, 1),
      reorderLevel,
      1,
      toSql(addMinutes(t0, -rng.int(1, 60) * 24 * 60)),
    ]);
  }
  await bulkInsert(pool, 'products', ['sku', 'product_name', 'category', 'unit_weight', 'unit_length', 'unit_width', 'unit_height', 'reorder_level', 'active', 'created_at'], productRows);

  // ---- inventory ----
  const inventoryRows: unknown[][] = [];
  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i]!;
    const locationCount = i < 60 ? 4 : 3;
    for (let l = 0; l < locationCount; l++) {
      const quantity = rng.int(40, 200);
      const reserved = rng.int(5, Math.round(quantity * 0.6));
      const damaged = rng.int(0, Math.round(quantity * 0.05));
      inventoryRows.push([sku, locationCode(rng), quantity, reserved, damaged, toSql(addMinutes(t0, -rng.int(0, 20 * 24 * 60)))]);
    }
  }
  // A small, deliberate set of already-open inventory conditions (Step 16: ~10-20% anomalies,
  // never "all of them") — a handful of discrepancies (reserved > quantity) and a handful of
  // SKUs already below reorder level, both realistic ongoing conditions, not months-stale ones.
  for (let i = 0; i < 5; i++) {
    const row = inventoryRows[rng.int(0, inventoryRows.length - 1)]!;
    row[3] = (row[2] as number) + rng.int(5, 25); // reserved_quantity > quantity
  }
  for (let i = 0; i < 6; i++) {
    const sku = skus[rng.int(0, skus.length - 1)]!;
    const reorderLevel = reorderLevelBySku.get(sku)!;
    // Zero out this SKU's other locations' availability and set one location just below reorder.
    for (const row of inventoryRows) {
      if (row[0] === sku) {
        row[2] = Math.max(1, Math.round(reorderLevel * 0.6));
        row[3] = 0;
        row[4] = 0;
      }
    }
  }
  await bulkInsert(pool, 'inventory', ['sku', 'location', 'quantity', 'reserved_quantity', 'damaged_quantity', 'last_updated'], inventoryRows);

  const catalog: Catalog = { skus, reorderLevelBySku };
  const pickers = Array.from({ length: PICKER_COUNT }, (_, i) => `PICKER-${101 + i}`);
  const packers = Array.from({ length: PACKER_COUNT }, (_, i) => `PACKER-${401 + i}`);

  // ---- orders + downstream chains ----
  const counts: [OrderStatus, number][] = [
    ['DISPATCHED', 430],
    ['READY_TO_DISPATCH', 75],
    ['PACKING', 45],
    ['PICKING', 80],
    ['ALLOCATED', 12],
    ['RECEIVED', 6],
    ['ON_HOLD', 6],
    ['CANCELLED', 6],
  ];

  const generated: GenOrder[] = [];
  for (const [status, count] of counts) {
    for (let i = 0; i < count; i++) {
      switch (status) {
        case 'DISPATCHED':
          generated.push(buildDispatchedOrder(rng, catalog, t0, pickers, packers));
          break;
        case 'READY_TO_DISPATCH':
          generated.push(buildReadyToDispatchOrder(rng, catalog, t0, pickers, packers));
          break;
        case 'PACKING':
          generated.push(buildPackingOrder(rng, catalog, t0, pickers));
          break;
        case 'PICKING':
          generated.push(buildPickingOrder(rng, catalog, t0, pickers));
          break;
        default:
          generated.push(buildEarlyStageOrder(rng, catalog, t0, status, pickers));
          break;
      }
    }
  }

  const orderRows = generated.map((o) => [o.orderId, o.customerId, o.priority, toSql(o.orderTime), toSql(o.expectedDispatch), o.status, toSql(o.orderTime), toSql(o.orderTime)]);
  await bulkInsert(pool, 'orders', ['order_id', 'customer_id', 'priority', 'order_time', 'expected_dispatch', 'status', 'created_at', 'updated_at'], orderRows);
  const orderIdMap = await loadCodeToIdMap(pool, 'orders', 'order_id');

  const orderItemRows: unknown[][] = [];
  for (const o of generated) {
    const id = orderIdMap.get(o.orderId)!;
    for (const item of o.items) orderItemRows.push([id, item.sku, item.quantity, item.pickedQuantity, item.packedQuantity]);
  }
  await bulkInsert(pool, 'order_items', ['order_id', 'sku', 'quantity', 'picked_quantity', 'packed_quantity'], orderItemRows);

  const taskRows: unknown[][] = [];
  const taskRefByTaskId = new Map<string, GenPickingTask>();
  for (const o of generated) {
    const id = orderIdMap.get(o.orderId)!;
    for (const task of o.pickingTasks) {
      taskRefByTaskId.set(task.taskId, task);
      taskRows.push([task.taskId, id, task.pickerId, task.startTime ? toSql(task.startTime) : null, task.endTime ? toSql(task.endTime) : null, task.errors, task.distanceWalked, task.status]);
    }
  }
  await bulkInsert(pool, 'picking_tasks', ['task_id', 'order_id', 'picker_id', 'start_time', 'end_time', 'errors', 'distance_walked', 'status'], taskRows);
  const taskIdMap = await loadCodeToIdMap(pool, 'picking_tasks', 'task_id');

  const taskItemRows: unknown[][] = [];
  for (const [taskId, task] of taskRefByTaskId) {
    const id = taskIdMap.get(taskId)!;
    for (const item of task.items) taskItemRows.push([id, item.sku, item.location, item.requestedQuantity, item.pickedQuantity, item.errorReason]);
  }
  await bulkInsert(pool, 'picking_task_items', ['task_id', 'sku', 'location', 'requested_quantity', 'picked_quantity', 'error_reason'], taskItemRows);

  const packingRows: unknown[][] = [];
  for (const o of generated) {
    if (!o.packing) continue;
    const id = orderIdMap.get(o.orderId)!;
    packingRows.push([id, toSql(o.packing.packingTime), o.packing.packageSize, o.packing.weight, o.packing.damaged ? 1 : 0, o.packing.packedBy]);
  }
  await bulkInsert(pool, 'packing', ['order_id', 'packing_time', 'package_size', 'weight', 'damaged', 'packed_by'], packingRows);

  const dispatchRows: unknown[][] = [];
  for (const o of generated) {
    if (!o.dispatch) continue;
    const id = orderIdMap.get(o.orderId)!;
    dispatchRows.push([id, o.dispatch.truck, o.dispatch.carrier, o.dispatch.dock, o.dispatch.loadingTime ? toSql(o.dispatch.loadingTime) : null, o.dispatch.departureTime ? toSql(o.dispatch.departureTime) : null]);
  }
  await bulkInsert(pool, 'dispatch', ['order_id', 'truck', 'carrier', 'dock', 'loading_time', 'departure_time'], dispatchRows);

  // ---- returns (Step 15) — reference a subset of DISPATCHED orders; 2-3 SKUs deliberately
  // pushed toward HIGH_RETURN_RATE, the rest kept low, matching Step 16's "mostly normal". ----
  const dispatchedOrders = generated.filter((o) => o.status === 'DISPATCHED');
  const problemSkus = new Set(rng.shuffle(skus).slice(0, 3));
  const returnRows: unknown[][] = [];
  for (const o of rng.shuffle(dispatchedOrders).slice(0, Math.min(160, dispatchedOrders.length))) {
    const id = orderIdMap.get(o.orderId)!;
    const item = rng.pick(o.items);
    const isProblem = problemSkus.has(item.sku);
    if (!isProblem && !rng.chance(0.18)) continue;
    const returnedAt = addMinutes(t0, -rng.int(60, 29 * 24 * 60));
    returnRows.push([nextReturnId(), id, item.sku, rng.pick(RETURN_REASONS), rng.weighted([['DAMAGED', 30], ['DEFECTIVE', 20], ['GOOD', 25], ['USED', 15], ['UNKNOWN', 10]] as const), JSON.stringify([]), toSql(returnedAt)]);
    if (returnRows.length >= 140) break;
  }
  // Guarantee at least 100+ returns even if the sampling above came in low.
  while (returnRows.length < 110) {
    const o = rng.pick(dispatchedOrders);
    const id = orderIdMap.get(o.orderId)!;
    const item = rng.pick(o.items);
    const returnedAt = addMinutes(t0, -rng.int(60, 29 * 24 * 60));
    returnRows.push([nextReturnId(), id, item.sku, rng.pick(RETURN_REASONS), rng.weighted([['DAMAGED', 30], ['DEFECTIVE', 20], ['GOOD', 25], ['USED', 15], ['UNKNOWN', 10]] as const), JSON.stringify([]), toSql(returnedAt)]);
  }
  await bulkInsert(pool, 'returns', ['return_id', 'order_id', 'sku', 'reason', 'return_condition', 'photos', 'returned_at'], returnRows);

  const ordersByStatus: Record<string, number> = {};
  for (const [status, count] of counts) ordersByStatus[status] = count;

  return {
    customers: CUSTOMER_COUNT,
    products: productRows.length,
    inventory: inventoryRows.length,
    orders: generated.length,
    orderItems: orderItemRows.length,
    pickingTasks: taskRows.length,
    pickingTaskItems: taskItemRows.length,
    packing: packingRows.length,
    dispatch: dispatchRows.length,
    returns: returnRows.length,
    ordersByStatus,
  };
}
