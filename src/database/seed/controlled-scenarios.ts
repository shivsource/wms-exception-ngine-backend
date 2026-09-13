import { randomUUID } from 'node:crypto';
import { Pool } from 'mysql2/promise';
import { addMinutes, toSql } from './time';
import { bulkInsert, loadCodeToIdMap } from './insert-helpers';

/**
 * The 15 controlled prediction-validation scenarios (Step 9), seeded directly into the same
 * real tables as the general dataset but with clearly identifiable VAL-* ids, kept
 * structurally separate from the random general dataset (Step "DO NOT USE THE EXISTING STALE
 * ORDERS" / "DATA ISOLATION"). Every scenario's T0 state is built so that, at the instant this
 * function returns, NONE of its exceptions exist yet — see each scenario's comment for
 * exactly which real, unmodified rule/predictor mechanism makes its designed outcome
 * (TP/FP/FN/TN/CONFIRMED/NOT_MEASURABLE) genuine rather than fabricated. `advance.ts` performs
 * the T1 state-changing step for scenarios that need one (see its own header); the
 * time-threshold scenarios (picking/SLA/dispatch delay TP/FN) need no T1 step at all — they
 * resolve purely from the live scheduler's real-clock delta against the static rows below.
 */

export type ExpectedResult = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'FALSE_NEGATIVE' | 'TRUE_NEGATIVE' | 'CONFIRMED_BEFORE_PREDICTION' | 'NOT_MEASURABLE';

export interface ScenarioTarget {
  scenarioId: string;
  category: string;
  predictionType: 'SLA_BREACH_RISK' | 'PICKING_DELAY_RISK' | 'INVENTORY_SHORTAGE_RISK' | 'DISPATCH_DELAY_RISK' | null;
  entityType: 'ORDER' | 'PICKING_TASK' | 'PRODUCT';
  entityId: string;
  exceptionType: string | null;
  expectedResult: ExpectedResult;
  notes: string;
  /** True only for S3: its designed breach point is ~48 real minutes after T0 (a genuinely
   *  low-risk task, at the single moment it's evaluated, that later gets stuck with no
   *  re-evaluation in between -- see its notes). db:seed's short (~5min) observation window
   *  cannot show its true FALSE_NEGATIVE outcome; within that window it correctly (not
   *  incorrectly) still reads as "nothing has happened yet". Excluded from the seed run's
   *  pass/fail gate for that reason -- re-check it with `npm run simulation:validate` at
   *  approximately T0+48min to see it resolve for real. */
  longHorizon?: true;
}

export interface AdvanceStep {
  scenarioId: string;
  description: string;
  apply: (pool: Pool) => Promise<void>;
}

export interface ControlledScenariosResult {
  targets: ScenarioTarget[];
  advanceSteps: AdvanceStep[];
}

const CUSTOMER = 'CUST-VAL';
const PICKER = 'PICKER-VAL';
const PACKER = 'PACKER-VAL';

/** Pure, t0-independent scenario metadata -- reused by seedControlledScenarios (which pairs
 *  it with the actual DB seeding, below) AND by `npm run simulation:validate` (which measures
 *  the current state of an already-seeded database without re-seeding it). Kept as a single
 *  source of truth so the two never drift apart. */
export function buildScenarioTargetsManifest(): ScenarioTarget[] {
  return [
    { scenarioId: 'S1', category: 'PICKING_DELAY_TP', predictionType: 'PICKING_DELAY_RISK', entityType: 'PICKING_TASK', entityId: 'VAL-PICK-001', exceptionType: 'PICKING_DELAY', expectedResult: 'TRUE_POSITIVE', notes: 'Elapsed 58min at T0 (already MEDIUM+ risk); crosses the 60min stuck threshold live ~3 real minutes later.' },
    { scenarioId: 'S2', category: 'PICKING_DELAY_FP', predictionType: 'PICKING_DELAY_RISK', entityType: 'PICKING_TASK', entityId: 'VAL-PICK-002', exceptionType: 'PICKING_DELAY', expectedResult: 'FALSE_POSITIVE', notes: 'Elapsed 50min at T0 (MEDIUM+ risk); advance step completes the task before it ever reaches 60min.' },
    { scenarioId: 'S3', category: 'PICKING_DELAY_FN', predictionType: 'PICKING_DELAY_RISK', entityType: 'PICKING_TASK', entityId: 'VAL-PICK-003', exceptionType: 'PICKING_DELAY', expectedResult: 'FALSE_NEGATIVE', notes: 'Elapsed only 12min at the single (deliberately not repeated) prediction run -- genuinely low risk then, stuck ~48 real minutes later with no re-evaluation in between.', longHorizon: true },
    { scenarioId: 'S4', category: 'PICKING_HEALTHY_TN', predictionType: 'PICKING_DELAY_RISK', entityType: 'PICKING_TASK', entityId: 'VAL-PICK-004', exceptionType: 'PICKING_DELAY', expectedResult: 'TRUE_NEGATIVE', notes: 'Elapsed 20min, low risk; advance step completes it healthily.' },
    { scenarioId: 'S5', category: 'INVENTORY_SHORTAGE_TP', predictionType: 'INVENTORY_SHORTAGE_RISK', entityType: 'PRODUCT', entityId: 'VAL-SKU-001', exceptionType: 'INVENTORY_SHORTAGE', expectedResult: 'TRUE_POSITIVE', notes: 'Available (53) >= reorder (50) at T0 so the rule is silent; pending demand (150) already scores MEDIUM+ risk. T1 further consumption drops available below reorder.' },
    { scenarioId: 'S6', category: 'INVENTORY_SHORTAGE_FP', predictionType: 'INVENTORY_SHORTAGE_RISK', entityType: 'PRODUCT', entityId: 'VAL-SKU-002', exceptionType: 'INVENTORY_SHORTAGE', expectedResult: 'FALSE_POSITIVE', notes: 'Same risk shape as S5. T1 is a replenishment instead of further consumption; shortage never occurs.' },
    { scenarioId: 'S7', category: 'INVENTORY_SHORTAGE_FN', predictionType: 'INVENTORY_SHORTAGE_RISK', entityType: 'PRODUCT', entityId: 'VAL-SKU-003', exceptionType: 'INVENTORY_SHORTAGE', expectedResult: 'FALSE_NEGATIVE', notes: 'Genuinely low risk at T0 (correctly not flagged). T1 is a sudden large reservation; predictions are never re-run before the exception fires (this system only re-evaluates predictions on demand, not continuously) -> no forewarning existed.' },
    { scenarioId: 'S8', category: 'INVENTORY_HEALTHY_TN', predictionType: 'INVENTORY_SHORTAGE_RISK', entityType: 'PRODUCT', entityId: 'VAL-SKU-004', exceptionType: 'INVENTORY_SHORTAGE', expectedResult: 'TRUE_NEGATIVE', notes: 'Comfortable stock, low demand, never mutated.' },
    { scenarioId: 'S9', category: 'DISPATCH_DELAY_TP', predictionType: 'DISPATCH_DELAY_RISK', entityType: 'ORDER', entityId: 'VAL-ORD-005', exceptionType: 'DISPATCH_DELAY', expectedResult: 'TRUE_POSITIVE', notes: 'Packed 58min ago, expected_dispatch well within the 240min predictor candidate window -> already MEDIUM+ risk at T0; crosses the 60min threshold live ~2 real minutes later.' },
    { scenarioId: 'S10', category: 'DISPATCH_DELAY_FP', predictionType: 'DISPATCH_DELAY_RISK', entityType: 'ORDER', entityId: 'VAL-ORD-006', exceptionType: 'DISPATCH_DELAY', expectedResult: 'FALSE_POSITIVE', notes: 'Packed 50min ago (MEDIUM+ risk); advance step departs the truck before it reaches 60min.' },
    { scenarioId: 'S11', category: 'DISPATCH_DELAY_FN', predictionType: 'DISPATCH_DELAY_RISK', entityType: 'ORDER', entityId: 'VAL-ORD-007', exceptionType: 'DISPATCH_DELAY', expectedResult: 'FALSE_NEGATIVE', notes: "expected_dispatch (+300min) sits outside DispatchDelayPredictor's own 240min candidate window -- structurally invisible to the predictor at any time -- while DispatchDelayRule (no such window check) fires live ~1 real minute after seeding." },
    { scenarioId: 'S12', category: 'DISPATCH_HEALTHY_TN', predictionType: 'DISPATCH_DELAY_RISK', entityType: 'ORDER', entityId: 'VAL-ORD-008', exceptionType: 'DISPATCH_DELAY', expectedResult: 'TRUE_NEGATIVE', notes: 'Fully dispatched in the past, on time -- never a candidate.' },
    { scenarioId: 'S12', category: 'SLA_HEALTHY_TN', predictionType: 'SLA_BREACH_RISK', entityType: 'ORDER', entityId: 'VAL-ORD-008', exceptionType: 'SLA_AT_RISK', expectedResult: 'TRUE_NEGATIVE', notes: 'Already DISPATCHED -- never a candidate.' },
    { scenarioId: 'S13', category: 'MULTIPLE_SIMULTANEOUS_RISKS_SLA', predictionType: 'SLA_BREACH_RISK', entityType: 'ORDER', entityId: 'VAL-ORD-009', exceptionType: 'SLA_AT_RISK', expectedResult: 'TRUE_POSITIVE', notes: 'expected_dispatch at T0+124min, 4min from entering the 120min SLA_AT_RISK window -> fires live ~4 real minutes after seeding, simultaneously with the picking-delay leg below.' },
    { scenarioId: 'S13', category: 'MULTIPLE_SIMULTANEOUS_RISKS_PICKING', predictionType: 'PICKING_DELAY_RISK', entityType: 'PICKING_TASK', entityId: 'VAL-PICK-009', exceptionType: 'PICKING_DELAY', expectedResult: 'TRUE_POSITIVE', notes: 'Same shape as S1 (elapsed 58min at T0) -- both risks on the same order resolve independently and are measured independently.' },
    { scenarioId: 'S14', category: 'ALREADY_CONFIRMED_EXCEPTION', predictionType: 'PICKING_DELAY_RISK', entityType: 'PICKING_TASK', entityId: 'VAL-PICK-010', exceptionType: 'PICKING_DELAY', expectedResult: 'CONFIRMED_BEFORE_PREDICTION', notes: 'The PICKING_DELAY exception is pre-seeded OPEN before predictions are ever run; the first prediction run finds it via findExistingOpen() and is persisted CONFIRMED, never ACTIVE.' },
    { scenarioId: 'S15', category: 'INSUFFICIENT_DATA', predictionType: 'SLA_BREACH_RISK', entityType: 'ORDER', entityId: 'VAL-ORD-011', exceptionType: 'SLA_AT_RISK', expectedResult: 'NOT_MEASURABLE', notes: 'orders.status is NULL -- SlaBreachPredictor.evaluateOne (and DispatchDelayPredictor.evaluateOne) both explicitly return INSUFFICIENT_DATA for a null status; evaluateAll never selects it as a candidate either.' },
  ];
}

export async function seedControlledScenarios(pool: Pool, t0: Date): Promise<ControlledScenariosResult> {
  const targets: ScenarioTarget[] = buildScenarioTargetsManifest();
  const advanceSteps: AdvanceStep[] = [];

  // ---- VAL-SKU-001..004 (S5-S8: inventory shortage) ----
  const skuRows: unknown[][] = [
    ['VAL-SKU-001', 'Validation Widget 1 (shortage TP)', 'Validation', 1, 5, 5, 5, 50, 1, toSql(addMinutes(t0, -60))],
    ['VAL-SKU-002', 'Validation Widget 2 (shortage FP)', 'Validation', 1, 5, 5, 5, 50, 1, toSql(addMinutes(t0, -60))],
    ['VAL-SKU-003', 'Validation Widget 3 (shortage FN)', 'Validation', 1, 5, 5, 5, 50, 1, toSql(addMinutes(t0, -60))],
    ['VAL-SKU-004', 'Validation Widget 4 (healthy)', 'Validation', 1, 5, 5, 5, 50, 1, toSql(addMinutes(t0, -60))],
  ];
  await bulkInsert(pool, 'products', ['sku', 'product_name', 'category', 'unit_weight', 'unit_length', 'unit_width', 'unit_height', 'reorder_level', 'active', 'created_at'], skuRows);

  // S5 TP: available (53) still >= reorderLevel(50) at T0 (rule silent) but heavy pending
  // demand (150) already makes InventoryShortagePredictor's PENDING_DEMAND_SHORTFALL signal
  // score MEDIUM+ — a genuine "predictor sees it coming before the rule's own threshold is
  // crossed" case. T1 (advance.ts) further consumption drops available below 50 -> TRUE_POSITIVE.
  const s5InventoryRows: unknown[][] = [['VAL-SKU-001', 'VAL-LOC-01', 111, 58, 6, toSql(addMinutes(t0, -30))]];
  // S6 FP: identical risk shape to S5. T1 is a replenishment instead of further consumption.
  const s6InventoryRows: unknown[][] = [['VAL-SKU-002', 'VAL-LOC-02', 111, 58, 6, toSql(addMinutes(t0, -30))]];
  // S7 FN: comfortable at T0 (available 200, pending demand only 15) -> genuinely LOW risk,
  // correctly not flagged. T1 is a sudden large reservation nobody re-evaluated predictions
  // for -> exception fires with no preceding meaningful prediction.
  const s7InventoryRows: unknown[][] = [['VAL-SKU-003', 'VAL-LOC-03', 210, 10, 0, toSql(addMinutes(t0, -30))]];
  // S8 TN: comfortable and never mutated.
  const s8InventoryRows: unknown[][] = [['VAL-SKU-004', 'VAL-LOC-04', 210, 10, 0, toSql(addMinutes(t0, -30))]];
  await bulkInsert(pool, 'inventory', ['sku', 'location', 'quantity', 'reserved_quantity', 'damaged_quantity', 'last_updated'], [
    ...s5InventoryRows,
    ...s6InventoryRows,
    ...s7InventoryRows,
    ...s8InventoryRows,
  ]);


  advanceSteps.push(
    {
      scenarioId: 'S5',
      description: 'Further consumption on VAL-SKU-001: quantity 111 -> 90 (available drops from 53 to 32, below reorder level 50).',
      apply: (p) => p.query("UPDATE inventory SET quantity = 90 WHERE sku = 'VAL-SKU-001'").then(() => undefined),
    },
    {
      scenarioId: 'S6',
      description: 'Replenishment on VAL-SKU-002: quantity 111 -> 160 (available rises from 53 to 102, comfortably above reorder level 50).',
      apply: (p) => p.query("UPDATE inventory SET quantity = 160 WHERE sku = 'VAL-SKU-002'").then(() => undefined),
    },
    {
      scenarioId: 'S7',
      description: 'Sudden large reservation on VAL-SKU-003: reserved_quantity 10 -> 190 (available drops from 200 to 20, below reorder level 50) -- deliberately not preceded by a fresh prediction run.',
      apply: (p) => p.query("UPDATE inventory SET reserved_quantity = 190 WHERE sku = 'VAL-SKU-003'").then(() => undefined),
    },
  );

  // ---- Orders (S1-S4, S9-S15) ----
  interface OrderDef {
    orderId: string;
    priority: string;
    orderTime: Date;
    expectedDispatch: Date;
    status: string | null;
    items: { sku: string; quantity: number; pickedQuantity: number; packedQuantity: number }[];
  }
  const orderDefs: OrderDef[] = [
    { orderId: 'VAL-ORD-001', priority: 'NORMAL', orderTime: addMinutes(t0, -70), expectedDispatch: addMinutes(t0, 300), status: 'PICKING', items: [{ sku: 'VAL-SKU-001', quantity: 4, pickedQuantity: 2, packedQuantity: 0 }] },
    { orderId: 'VAL-ORD-002', priority: 'NORMAL', orderTime: addMinutes(t0, -60), expectedDispatch: addMinutes(t0, 300), status: 'PICKING', items: [{ sku: 'VAL-SKU-002', quantity: 5, pickedQuantity: 3, packedQuantity: 0 }] },
    { orderId: 'VAL-ORD-003', priority: 'NORMAL', orderTime: addMinutes(t0, -12), expectedDispatch: addMinutes(t0, 300), status: 'PICKING', items: [{ sku: 'VAL-SKU-003', quantity: 3, pickedQuantity: 0, packedQuantity: 0 }] },
    { orderId: 'VAL-ORD-004', priority: 'NORMAL', orderTime: addMinutes(t0, -30), expectedDispatch: addMinutes(t0, 300), status: 'PICKING', items: [{ sku: 'VAL-SKU-004', quantity: 2, pickedQuantity: 1, packedQuantity: 0 }] },
    { orderId: 'VAL-ORD-005', priority: 'HIGH', orderTime: addMinutes(t0, -120), expectedDispatch: addMinutes(t0, 150), status: 'READY_TO_DISPATCH', items: [{ sku: 'VAL-SKU-001', quantity: 2, pickedQuantity: 2, packedQuantity: 2 }] },
    { orderId: 'VAL-ORD-006', priority: 'HIGH', orderTime: addMinutes(t0, -120), expectedDispatch: addMinutes(t0, 150), status: 'READY_TO_DISPATCH', items: [{ sku: 'VAL-SKU-002', quantity: 2, pickedQuantity: 2, packedQuantity: 2 }] },
    { orderId: 'VAL-ORD-007', priority: 'NORMAL', orderTime: addMinutes(t0, -120), expectedDispatch: addMinutes(t0, 300), status: 'READY_TO_DISPATCH', items: [{ sku: 'VAL-SKU-003', quantity: 2, pickedQuantity: 2, packedQuantity: 2 }] },
    { orderId: 'VAL-ORD-008', priority: 'NORMAL', orderTime: addMinutes(t0, -400), expectedDispatch: addMinutes(t0, -60), status: 'DISPATCHED', items: [{ sku: 'VAL-SKU-004', quantity: 2, pickedQuantity: 2, packedQuantity: 2 }] },
    { orderId: 'VAL-ORD-009', priority: 'URGENT', orderTime: addMinutes(t0, -60), expectedDispatch: addMinutes(t0, 124), status: 'PICKING', items: [{ sku: 'VAL-SKU-001', quantity: 3, pickedQuantity: 0, packedQuantity: 0 }] },
    { orderId: 'VAL-ORD-010', priority: 'NORMAL', orderTime: addMinutes(t0, -90), expectedDispatch: addMinutes(t0, 300), status: 'PICKING', items: [{ sku: 'VAL-SKU-002', quantity: 3, pickedQuantity: 0, packedQuantity: 0 }] },
    { orderId: 'VAL-ORD-011', priority: 'NORMAL', orderTime: addMinutes(t0, -20), expectedDispatch: addMinutes(t0, 200), status: null, items: [] },
    { orderId: 'VAL-ORD-012', priority: 'NORMAL', orderTime: addMinutes(t0, -30), expectedDispatch: addMinutes(t0, 300), status: 'ALLOCATED', items: [{ sku: 'VAL-SKU-001', quantity: 150, pickedQuantity: 0, packedQuantity: 0 }] },
    { orderId: 'VAL-ORD-013', priority: 'NORMAL', orderTime: addMinutes(t0, -30), expectedDispatch: addMinutes(t0, 300), status: 'ALLOCATED', items: [{ sku: 'VAL-SKU-002', quantity: 150, pickedQuantity: 0, packedQuantity: 0 }] },
    { orderId: 'VAL-ORD-014', priority: 'NORMAL', orderTime: addMinutes(t0, -30), expectedDispatch: addMinutes(t0, 300), status: 'ALLOCATED', items: [{ sku: 'VAL-SKU-003', quantity: 15, pickedQuantity: 0, packedQuantity: 0 }] },
  ];

  const orderRows = orderDefs.map((o) => [o.orderId, CUSTOMER, o.priority, toSql(o.orderTime), toSql(o.expectedDispatch), o.status, toSql(o.orderTime), toSql(o.orderTime)]);
  await bulkInsert(pool, 'orders', ['order_id', 'customer_id', 'priority', 'order_time', 'expected_dispatch', 'status', 'created_at', 'updated_at'], orderRows);
  const orderIdMap = await loadCodeToIdMap(pool, 'orders', 'order_id');

  const orderItemRows: unknown[][] = [];
  for (const o of orderDefs) {
    const id = orderIdMap.get(o.orderId)!;
    for (const item of o.items) orderItemRows.push([id, item.sku, item.quantity, item.pickedQuantity, item.packedQuantity]);
  }
  await bulkInsert(pool, 'order_items', ['order_id', 'sku', 'quantity', 'picked_quantity', 'packed_quantity'], orderItemRows);

  // ---- Picking tasks (S1-S4, S9-S10 need none directly; S13-S14 need one) ----
  interface TaskDef {
    taskId: string;
    orderId: string;
    startTime: Date | null;
    endTime: Date | null;
    status: string;
    items: { sku: string; quantity: number; pickedQuantity: number }[];
  }
  const taskDefs: TaskDef[] = [
    // S1 TP: elapsed 58min at T0 (baseline overage already saturated, elapsedVsThreshold=19/20)
    // -> MEDIUM+ prediction now; real elapsed crosses the 60min stuck threshold ~3 real
    // minutes after this function returns -> PickingDelayRule fires live, no mutation needed.
    { taskId: 'VAL-PICK-001', orderId: 'VAL-ORD-001', startTime: addMinutes(t0, -58), endTime: null, status: 'IN_PROGRESS', items: [{ sku: 'VAL-SKU-001', quantity: 4, pickedQuantity: 2 }] },
    // S2 FP: elapsed 50min at T0 -> MEDIUM+ prediction now; advance.ts completes this task
    // immediately afterward (end_time = the moment it runs, elapsed ~50-52min, still under 60)
    // -> the task finishes before ever becoming stuck.
    { taskId: 'VAL-PICK-002', orderId: 'VAL-ORD-002', startTime: addMinutes(t0, -50), endTime: null, status: 'IN_PROGRESS', items: [{ sku: 'VAL-SKU-002', quantity: 5, pickedQuantity: 3 }] },
    // S3 FN: elapsed only 12min at T0 -> genuinely LOW risk right now (correctly so). This
    // prediction run is deliberately the ONLY one ever taken for this task -- this system has
    // no cron for predictions (only for exception detection, see exception-scheduler.ts), so a
    // task that looked fine at the one moment it was checked and became stuck ~48 real minutes
    // later is a genuine, structural false negative, not a fabricated one.
    { taskId: 'VAL-PICK-003', orderId: 'VAL-ORD-003', startTime: addMinutes(t0, -12), endTime: null, status: 'IN_PROGRESS', items: [{ sku: 'VAL-SKU-003', quantity: 3, pickedQuantity: 0 }] },
    // S4 TN: elapsed 20min at T0, LOW risk; advance.ts completes it healthily right after.
    { taskId: 'VAL-PICK-004', orderId: 'VAL-ORD-004', startTime: addMinutes(t0, -20), endTime: null, status: 'IN_PROGRESS', items: [{ sku: 'VAL-SKU-004', quantity: 2, pickedQuantity: 1 }] },
    // S13 leg B (picking-delay risk half of "multiple simultaneous risks"): same shape as S1.
    { taskId: 'VAL-PICK-009', orderId: 'VAL-ORD-009', startTime: addMinutes(t0, -58), endTime: null, status: 'IN_PROGRESS', items: [{ sku: 'VAL-SKU-001', quantity: 3, pickedQuantity: 0 }] },
    // S14 already-confirmed: elapsed 90min -- already well past stuck. Its OPEN exception is
    // pre-seeded below BEFORE any prediction is ever run, so PredictionEngine.persist() will
    // find it via findExistingOpen() on the very first evaluation and mark CONFIRMED, never ACTIVE.
    { taskId: 'VAL-PICK-010', orderId: 'VAL-ORD-010', startTime: addMinutes(t0, -90), endTime: null, status: 'IN_PROGRESS', items: [{ sku: 'VAL-SKU-002', quantity: 3, pickedQuantity: 0 }] },
    // Completed picking history for the dispatch scenarios (S9-S12) -- inserted so
    // packing/dispatch never sit on top of a nonexistent picking stage (Step 5 realism);
    // pickingComplete=true keeps DispatchDelayPredictor's PICKING_INCOMPLETE signal at 0,
    // matching each scenario's designed score exactly.
    { taskId: 'VAL-PICK-005', orderId: 'VAL-ORD-005', startTime: addMinutes(t0, -90), endTime: addMinutes(t0, -60), status: 'COMPLETED', items: [{ sku: 'VAL-SKU-001', quantity: 2, pickedQuantity: 2 }] },
    { taskId: 'VAL-PICK-006', orderId: 'VAL-ORD-006', startTime: addMinutes(t0, -85), endTime: addMinutes(t0, -55), status: 'COMPLETED', items: [{ sku: 'VAL-SKU-002', quantity: 2, pickedQuantity: 2 }] },
    { taskId: 'VAL-PICK-007', orderId: 'VAL-ORD-007', startTime: addMinutes(t0, -95), endTime: addMinutes(t0, -64), status: 'COMPLETED', items: [{ sku: 'VAL-SKU-003', quantity: 2, pickedQuantity: 2 }] },
    { taskId: 'VAL-PICK-008', orderId: 'VAL-ORD-008', startTime: addMinutes(t0, -395), endTime: addMinutes(t0, -365), status: 'COMPLETED', items: [{ sku: 'VAL-SKU-004', quantity: 2, pickedQuantity: 2 }] },
  ];
  const taskRows = taskDefs.map((t) => [t.taskId, orderIdMap.get(t.orderId)!, PICKER, t.startTime ? toSql(t.startTime) : null, t.endTime ? toSql(t.endTime) : null, 0, null, t.status]);
  await bulkInsert(pool, 'picking_tasks', ['task_id', 'order_id', 'picker_id', 'start_time', 'end_time', 'errors', 'distance_walked', 'status'], taskRows);
  const taskIdMap = await loadCodeToIdMap(pool, 'picking_tasks', 'task_id');

  const taskItemRows: unknown[][] = [];
  for (const t of taskDefs) {
    const id = taskIdMap.get(t.taskId)!;
    for (const item of t.items) taskItemRows.push([id, item.sku, 'VAL-LOC-P', item.quantity, item.pickedQuantity, null]);
  }
  await bulkInsert(pool, 'picking_task_items', ['task_id', 'sku', 'location', 'requested_quantity', 'picked_quantity', 'error_reason'], taskItemRows);


  advanceSteps.push(
    {
      scenarioId: 'S2',
      description: 'Complete VAL-PICK-002 (status -> COMPLETED, end_time -> now) before it reaches the 60min stuck threshold.',
      apply: (p) =>
        p
          .query("UPDATE picking_tasks SET status = 'COMPLETED', end_time = NOW(), distance_walked = 480 WHERE task_id = 'VAL-PICK-002'")
          .then(() => p.query("UPDATE order_items oi JOIN orders o ON oi.order_id = o.id SET oi.picked_quantity = oi.quantity WHERE o.order_id = 'VAL-ORD-002'"))
          .then(() => undefined),
    },
    {
      scenarioId: 'S4',
      description: 'Complete VAL-PICK-004 healthily (status -> COMPLETED, end_time -> now).',
      apply: (p) =>
        p
          .query("UPDATE picking_tasks SET status = 'COMPLETED', end_time = NOW(), distance_walked = 420 WHERE task_id = 'VAL-PICK-004'")
          .then(() => p.query("UPDATE order_items oi JOIN orders o ON oi.order_id = o.id SET oi.picked_quantity = oi.quantity WHERE o.order_id = 'VAL-ORD-004'"))
          .then(() => undefined),
    },
  );

  // ---- Packing/dispatch rows (S5-S12 already inserted above via orders; now S9/S10/S11) ----
  interface PackingDef {
    orderId: string;
    packingTime: Date;
  }
  const packingDefs: PackingDef[] = [
    // S9 TP: packed 58min ago -> DISPATCH_DELAY fires live ~2 real minutes after seeding.
    { orderId: 'VAL-ORD-005', packingTime: addMinutes(t0, -58) },
    // S10 FP: packed 50min ago -> advance.ts departs it before it reaches 60min.
    { orderId: 'VAL-ORD-006', packingTime: addMinutes(t0, -50) },
    // S11 FN: packed 59min ago, but expected_dispatch (+300min) is OUTSIDE
    // thresholds.prediction.dispatchDelay.windowMinutes (240) -- DispatchDelayPredictor's own
    // candidate filter (findOrdersAtRiskOfSlaBreach, 240min window) never selects this order at
    // all, structurally, regardless of when it's evaluated. DispatchDelayRule has no such
    // window check, so the exception still fires live ~1 real minute after seeding.
    { orderId: 'VAL-ORD-007', packingTime: addMinutes(t0, -59) },
    // S8/S12 healthy dispatch TN already fully resolved via VAL-ORD-008's DISPATCHED status.
  ];
  const packingRows = packingDefs.map((p) => [orderIdMap.get(p.orderId)!, toSql(p.packingTime), '30x20x15', 3.2, 0, PACKER]);
  await bulkInsert(pool, 'packing', ['order_id', 'packing_time', 'package_size', 'weight', 'damaged', 'packed_by'], packingRows);

  const s8PackingTime = addMinutes(orderDefs.find((o) => o.orderId === 'VAL-ORD-008')!.orderTime, 40);
  const s8LoadingTime = addMinutes(s8PackingTime, 20);
  const s8DepartureTime = addMinutes(s8LoadingTime, 15);
  await bulkInsert(pool, 'packing', ['order_id', 'packing_time', 'package_size', 'weight', 'damaged', 'packed_by'], [[orderIdMap.get('VAL-ORD-008')!, toSql(s8PackingTime), '20x15x10', 1.1, 0, PACKER]]);
  await bulkInsert(pool, 'dispatch', ['order_id', 'truck', 'carrier', 'dock', 'loading_time', 'departure_time'], [[orderIdMap.get('VAL-ORD-008')!, 'TRUCK-VAL-01', 'Ecom Express', 'DOCK-VAL', toSql(s8LoadingTime), toSql(s8DepartureTime)]]);


  advanceSteps.push({
    scenarioId: 'S10',
    description: 'Depart VAL-ORD-006 (insert dispatch row with departure_time = now) before it reaches the 60min packed-and-waiting threshold.',
    apply: (p) => p.query("INSERT INTO dispatch (order_id, truck, carrier, dock, loading_time, departure_time) SELECT id, 'TRUCK-VAL-02', 'Ekart', 'DOCK-VAL', NOW(), NOW() FROM orders WHERE order_id = 'VAL-ORD-006'").then(() => undefined),
  });

  // ---- S13: multiple simultaneous risks on VAL-ORD-009 (SLA leg) + VAL-PICK-009 (picking leg, defined above) ----

  // ---- S14: already-confirmed exception, pre-seeded BEFORE any prediction ever runs ----
  const s14ExceptionId = `EXC-${randomUUID()}`;
  const s14DetectedAt = addMinutes(t0, -5);
  await pool.query(
    `INSERT INTO exceptions (exception_id, exception_type, entity_type, entity_id, severity, status, title, description, evidence, detected_at)
     VALUES (?, 'PICKING_DELAY', 'PICKING_TASK', 'VAL-PICK-010', 'HIGH', 'OPEN', ?, ?, ?, ?)`,
    [s14ExceptionId, 'Picking delay on task VAL-PICK-010', 'Pre-seeded for S14 (already-confirmed) validation scenario.', JSON.stringify({ taskCode: 'VAL-PICK-010', elapsedMinutes: 85 }), toSql(s14DetectedAt)],
  );

  // ---- S15: insufficient data (order with no recorded status) ----

  return { targets, advanceSteps };
}
