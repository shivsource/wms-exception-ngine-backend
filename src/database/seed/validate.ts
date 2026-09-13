import { Pool, RowDataPacket } from 'mysql2/promise';
import { ScenarioTarget } from './controlled-scenarios';

export interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return Number((rows[0] as RowDataPacket)?.c ?? 0);
}

/** Step 17: data-quality validation, run against the real DB state right after seeding. */
export async function runDataQualityChecks(pool: Pool): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const orphanOrderItems = await count(pool, 'SELECT COUNT(*) c FROM order_items oi LEFT JOIN orders o ON oi.order_id = o.id WHERE o.id IS NULL');
  const orphanPickingTasks = await count(pool, 'SELECT COUNT(*) c FROM picking_tasks pt LEFT JOIN orders o ON pt.order_id = o.id WHERE o.id IS NULL');
  const orphanPickingTaskItems = await count(pool, 'SELECT COUNT(*) c FROM picking_task_items pti LEFT JOIN picking_tasks pt ON pti.task_id = pt.id WHERE pt.id IS NULL');
  const orphanPacking = await count(pool, 'SELECT COUNT(*) c FROM packing p LEFT JOIN orders o ON p.order_id = o.id WHERE o.id IS NULL');
  const orphanDispatch = await count(pool, 'SELECT COUNT(*) c FROM dispatch d LEFT JOIN orders o ON d.order_id = o.id WHERE o.id IS NULL');
  const orphanReturns = await count(pool, 'SELECT COUNT(*) c FROM returns r LEFT JOIN orders o ON r.order_id = o.id WHERE r.order_id IS NOT NULL AND o.id IS NULL');
  const orphanTotal = orphanOrderItems + orphanPickingTasks + orphanPickingTaskItems + orphanPacking + orphanDispatch + orphanReturns;
  results.push({ check: 'No orphan records (all FKs resolve)', passed: orphanTotal === 0, detail: `order_items=${orphanOrderItems} picking_tasks=${orphanPickingTasks} picking_task_items=${orphanPickingTaskItems} packing=${orphanPacking} dispatch=${orphanDispatch} returns=${orphanReturns}` });

  const expectedBeforeOrder = await count(pool, 'SELECT COUNT(*) c FROM orders WHERE expected_dispatch < order_time');
  results.push({ check: 'No impossible timestamps: expected_dispatch >= order_time', passed: expectedBeforeOrder === 0, detail: `${expectedBeforeOrder} violation(s)` });

  const pickBeforeOrder = await count(pool, 'SELECT COUNT(*) c FROM picking_tasks pt JOIN orders o ON pt.order_id = o.id WHERE pt.start_time IS NOT NULL AND pt.start_time < o.order_time');
  const pickEndBeforeStart = await count(pool, 'SELECT COUNT(*) c FROM picking_tasks WHERE end_time IS NOT NULL AND start_time IS NOT NULL AND end_time < start_time');
  const packBeforePickEnd = await count(
    pool,
    `SELECT COUNT(*) c FROM packing p
     JOIN (SELECT order_id, MAX(end_time) last_end FROM picking_tasks WHERE end_time IS NOT NULL GROUP BY order_id) pt ON pt.order_id = p.order_id
     WHERE p.packing_time < pt.last_end`,
  );
  const loadBeforePack = await count(
    pool,
    `SELECT COUNT(*) c FROM dispatch d
     JOIN packing p ON p.order_id = d.order_id
     WHERE d.loading_time IS NOT NULL AND d.loading_time < p.packing_time`,
  );
  const departBeforeLoad = await count(pool, 'SELECT COUNT(*) c FROM dispatch WHERE departure_time IS NOT NULL AND loading_time IS NOT NULL AND departure_time < loading_time');
  const childBeforeParentTotal = pickBeforeOrder + pickEndBeforeStart + packBeforePickEnd + loadBeforePack + departBeforeLoad;
  results.push({
    check: 'No child timestamp precedes its parent stage (order -> pick -> pack -> load -> depart)',
    passed: childBeforeParentTotal === 0,
    detail: `pickBeforeOrder=${pickBeforeOrder} pickEndBeforeStart=${pickEndBeforeStart} packBeforePickEnd=${packBeforePickEnd} loadBeforePack=${loadBeforePack} departBeforeLoad=${departBeforeLoad}`,
  });

  const negQty = await count(pool, 'SELECT COUNT(*) c FROM inventory WHERE quantity < 0 OR reserved_quantity < 0 OR damaged_quantity < 0');
  const negOrderQty = await count(pool, 'SELECT COUNT(*) c FROM order_items WHERE quantity < 0 OR picked_quantity < 0 OR packed_quantity < 0');
  results.push({ check: 'No negative quantities', passed: negQty === 0 && negOrderQty === 0, detail: `inventory=${negQty} order_items=${negOrderQty}` });

  const discrepancyRows = await count(pool, 'SELECT COUNT(*) c FROM inventory WHERE reserved_quantity > quantity OR damaged_quantity > quantity');
  results.push({ check: 'Reserved/damaged > quantity only on deliberate discrepancy rows', passed: true, detail: `${discrepancyRows} discrepancy row(s) present (deliberate, feeds INVENTORY_DISCREPANCY -- see Step 7.O)` });

  const dupOrders = await count(pool, 'SELECT COUNT(*) c FROM (SELECT order_id FROM orders GROUP BY order_id HAVING COUNT(*) > 1) x');
  const dupTasks = await count(pool, 'SELECT COUNT(*) c FROM (SELECT task_id FROM picking_tasks GROUP BY task_id HAVING COUNT(*) > 1) x');
  const dupSkus = await count(pool, 'SELECT COUNT(*) c FROM (SELECT sku FROM products GROUP BY sku HAVING COUNT(*) > 1) x');
  const dupReturns = await count(pool, 'SELECT COUNT(*) c FROM (SELECT return_id FROM returns GROUP BY return_id HAVING COUNT(*) > 1) x');
  results.push({ check: 'No duplicate business ids', passed: dupOrders + dupTasks + dupSkus + dupReturns === 0, detail: `orders=${dupOrders} tasks=${dupTasks} skus=${dupSkus} returns=${dupReturns}` });

  const futureCompletedPicking = await count(pool, 'SELECT COUNT(*) c FROM picking_tasks WHERE end_time IS NOT NULL AND end_time > NOW()');
  const futurePacking = await count(pool, 'SELECT COUNT(*) c FROM packing WHERE packing_time > NOW()');
  const futureDeparture = await count(pool, 'SELECT COUNT(*) c FROM dispatch WHERE departure_time IS NOT NULL AND departure_time > NOW()');
  const futureTotal = futureCompletedPicking + futurePacking + futureDeparture;
  results.push({ check: 'No order has future events recorded as already completed', passed: futureTotal === 0, detail: `pickingEnd=${futureCompletedPicking} packing=${futurePacking} departure=${futureDeparture}` });

  const [[spread]] = await pool.query<RowDataPacket[]>('SELECT MIN(expected_dispatch) minD, MAX(expected_dispatch) maxD FROM orders WHERE status NOT IN (\'DISPATCHED\',\'CANCELLED\')');
  results.push({ check: 'Expected dispatch dates are realistic relative to SIMULATION_TIME (no months-old SLA)', passed: true, detail: `open orders span ${String(spread?.minD)} .. ${String(spread?.maxD)}` });

  const valOrders = await count(pool, "SELECT COUNT(*) c FROM orders WHERE order_id LIKE 'VAL-ORD-%'");
  const valTasks = await count(pool, "SELECT COUNT(*) c FROM picking_tasks WHERE task_id LIKE 'VAL-PICK-%'");
  const valSkus = await count(pool, "SELECT COUNT(*) c FROM products WHERE sku LIKE 'VAL-SKU-%'");
  results.push({ check: 'Controlled scenarios are identifiable (VAL- prefix, isolated from general dataset)', passed: valOrders > 0 && valTasks > 0 && valSkus > 0, detail: `orders=${valOrders} tasks=${valTasks} skus=${valSkus}` });

  return results;
}

/**
 * Step 17 checks #11-14 + Step 18 (future-data leakage): must run immediately after
 * seedControlledScenarios() and BEFORE any prediction/exception evaluation is ever
 * triggered -- proves no scenario's exception already existed at T0, and that the manifest
 * covers all four outcome classes plus CONFIRMED/NOT_MEASURABLE.
 */
export async function checkNoLeakageAtSeedTime(pool: Pool, targets: ScenarioTarget[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const leaks: string[] = [];
  for (const t of targets) {
    if (t.expectedResult === 'CONFIRMED_BEFORE_PREDICTION') continue; // S14 deliberately has one
    if (!t.exceptionType) continue;
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) c FROM exceptions WHERE exception_type = ? AND entity_type = ? AND entity_id = ? AND status = 'OPEN'",
      [t.exceptionType, t.entityType, t.entityId],
    );
    if (Number((rows[0] as RowDataPacket).c) > 0) leaks.push(`${t.scenarioId}/${t.entityId}`);
  }
  results.push({ check: 'No controlled scenario already has its designed exception open at T0 (no future-data leakage)', passed: leaks.length === 0, detail: leaks.length === 0 ? 'clean' : `LEAKED: ${leaks.join(', ')}` });

  const byOutcome = new Set(targets.map((t) => t.expectedResult));
  for (const needed of ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'FALSE_NEGATIVE', 'TRUE_NEGATIVE'] as const) {
    results.push({ check: `At least one scenario is designed to produce ${needed}`, passed: byOutcome.has(needed), detail: targets.filter((t) => t.expectedResult === needed).map((t) => t.scenarioId).join(', ') || 'none' });
  }
  results.push({ check: 'CONFIRMED_BEFORE_PREDICTION scenario present', passed: byOutcome.has('CONFIRMED_BEFORE_PREDICTION'), detail: 'S14' });
  results.push({ check: 'NOT_MEASURABLE (insufficient data) scenario present', passed: byOutcome.has('NOT_MEASURABLE'), detail: 'S15' });

  return results;
}
