import * as http from 'node:http';
import { URL } from 'node:url';
import { RowDataPacket } from 'mysql2/promise';
import { pool, closePool } from '../pool';
import { bulkInsert, loadCodeToIdMap } from './insert-helpers';
import { resolveSimulationTime, addMinutes, toSql } from './time';
import { logger } from '../../utils/logger';

/**
 * One-off, re-runnable scenario:
 *
 *                  MIX-ORDER-001
 *                        |
 *              +---------+---------+
 *              |                   |
 *              v                   v
 *       Inventory Shortage    Picking Delay
 *      (MIX-SKU-001, HIGH)  (MIX-TASK-001, MEDIUM)
 *              |                   |
 *              +---------+---------+
 *                        v
 *                  SLA At Risk            <- primary cause: INVENTORY_SHORTAGE (earliest in
 *                        |                    pipeline order); PICKING_DELAY is a contributing
 *                        v                    cause. See SlaAtRiskAnalyzer.PIPELINE_ORDER.
 *                SLA Breach Risk (prediction)
 *                        |
 *                        v
 *                 Recommendation
 *                        |
 *              +---------+---------+
 *              v                   v
 *          PRIORITIZE           REPLENISH        <- top-ranked recommendation vs. alternative;
 *                                                    see SlaAtRiskRecommender.
 *
 * PLUS a second, deliberately separate order (MIX-ORDER-002) that proves the prediction is a
 * genuine EARLY warning rather than a same-instant confirmation. It sits outside the 120min
 * SLA_AT_RISK exception window but inside SlaBreachPredictor's own wider 240min window, so
 * /predictions/evaluate reports risk_status=ACTIVE while NO SLA_AT_RISK exception exists yet
 * for it -- there is nothing to run root-cause/recommendation against at this point, which is
 * the point: a prediction with lead time necessarily precedes the exception it warns about, so
 * it structurally cannot also be part of an "exception+prediction+rootCause+recommendation,
 * all four simultaneously" order (MIX-ORDER-001, above) -- that order's prediction instead
 * comes back CONFIRMED (it confirms an already-open exception, no lead time). Both are correct,
 * intentional demonstrations of different (mutually exclusive, on the same order) behaviors.
 *
 * Run with the app already up and reachable (see SEED_APP_URL below):
 *   npx ts-node src/database/seed/mixed-case-scenario.ts
 */

const TEST_SKU = 'MIX-SKU-001';
const TEST_ORDER = 'MIX-ORDER-001';
const TEST_TASK = 'MIX-TASK-001';
const CUSTOMER = 'CUST-MIX-TEST';
const PICKER = 'PICKER-MIX-TEST';

const LEAD_TIME_SKU = 'MIX-SKU-002';
const LEAD_TIME_ORDER = 'MIX-ORDER-002';

const BASE_URL = process.env.SEED_APP_URL ?? 'http://localhost:6000';

function request(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function post(path: string): Promise<unknown> {
  const { status, body } = await request('POST', path);
  if (status < 200 || status >= 300) throw new Error(`POST ${path} failed: ${status} ${body}`);
  return body ? JSON.parse(body) : null;
}

async function cleanupPrevious(): Promise<void> {
  await pool.query(
    `DELETE er FROM exception_recommendations er JOIN exceptions e ON er.exception_id = e.id WHERE e.entity_id IN (?, ?, ?)`,
    [TEST_ORDER, TEST_SKU, TEST_TASK],
  );
  await pool.query(`DELETE rca FROM root_cause_analyses rca JOIN exceptions e ON rca.exception_id = e.id WHERE e.entity_id IN (?, ?, ?)`, [TEST_ORDER, TEST_SKU, TEST_TASK]);
  await pool.query(`DELETE FROM exceptions WHERE entity_id IN (?, ?, ?)`, [TEST_ORDER, TEST_SKU, TEST_TASK]);
  await pool.query(`DELETE FROM predictions WHERE entity_id IN (?, ?, ?)`, [TEST_ORDER, TEST_SKU, TEST_TASK]);
  await pool.query(`DELETE pti FROM picking_task_items pti JOIN picking_tasks pt ON pti.task_id = pt.id WHERE pt.task_id = ?`, [TEST_TASK]);
  await pool.query(`DELETE FROM picking_tasks WHERE task_id = ?`, [TEST_TASK]);
  await pool.query(`DELETE oi FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.order_id = ?`, [TEST_ORDER]);
  await pool.query(`DELETE FROM orders WHERE order_id = ?`, [TEST_ORDER]);
  await pool.query(`DELETE FROM inventory WHERE sku = ?`, [TEST_SKU]);
  await pool.query(`DELETE FROM products WHERE sku = ?`, [TEST_SKU]);

  await pool.query(`DELETE FROM predictions WHERE entity_id = ?`, [LEAD_TIME_ORDER]);
  await pool.query(`DELETE FROM exceptions WHERE entity_id IN (?, ?)`, [LEAD_TIME_ORDER, LEAD_TIME_SKU]);
  await pool.query(`DELETE oi FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.order_id = ?`, [LEAD_TIME_ORDER]);
  await pool.query(`DELETE FROM orders WHERE order_id = ?`, [LEAD_TIME_ORDER]);
  await pool.query(`DELETE FROM inventory WHERE sku = ?`, [LEAD_TIME_SKU]);
  await pool.query(`DELETE FROM products WHERE sku = ?`, [LEAD_TIME_SKU]);
}

async function seedOrder(t0: Date): Promise<void> {
  // Available (8) < reorder level (20): shortfall ratio 0.6 -> HIGH severity INVENTORY_SHORTAGE.
  await bulkInsert(
    pool,
    'products',
    ['sku', 'product_name', 'category', 'unit_weight', 'unit_length', 'unit_width', 'unit_height', 'reorder_level', 'active', 'created_at'],
    [[TEST_SKU, 'Mixed Case Test Widget', 'Test', 1, 5, 5, 5, 20, 1, toSql(addMinutes(t0, -60))]],
  );
  await bulkInsert(pool, 'inventory', ['sku', 'location', 'quantity', 'reserved_quantity', 'damaged_quantity', 'last_updated'], [[TEST_SKU, 'A1', 8, 0, 0, toSql(addMinutes(t0, -30))]]);

  // Order placed 100min ago, 45min left to dispatch: inside the 120min SLA_AT_RISK exception
  // window AND the 240min prediction window. urgencyRatio = 1 - 45/120 = 0.625 -> MEDIUM+
  // exception severity band. 45min < 60min slaUrgentMinutesRemaining -> recommendation engine
  // treats it as SLA-urgent (adds a PRIORITIZE action). URGENT priority + nothing picked/packed
  // yet -> prediction score saturates high.
  await bulkInsert(
    pool,
    'orders',
    ['order_id', 'customer_id', 'priority', 'order_time', 'expected_dispatch', 'status', 'created_at', 'updated_at'],
    [[TEST_ORDER, CUSTOMER, 'URGENT', toSql(addMinutes(t0, -100)), toSql(addMinutes(t0, 45)), 'PICKING', toSql(addMinutes(t0, -100)), toSql(addMinutes(t0, -100))]],
  );
  const orderIdMap = await loadCodeToIdMap(pool, 'orders', 'order_id');
  const orderId = orderIdMap.get(TEST_ORDER)!;

  await bulkInsert(pool, 'order_items', ['order_id', 'sku', 'quantity', 'picked_quantity', 'packed_quantity'], [[orderId, TEST_SKU, 5, 0, 0]]);

  // Started 75min ago (order was placed 100min ago, so this is temporally consistent) --
  // 75min > the 60min stuckAfterMinutes threshold in PickingDelayRule -> genuinely stuck ->
  // PICKING_DELAY exception, severity MEDIUM (75 falls in the [60,120) band). This is the
  // second leg of the "Inventory Shortage + Picking Delay -> SLA At Risk" scenario: the task
  // is picking MIX-SKU-001, the same SKU that is short, and its evidence.orderId matches
  // MIX-ORDER-001 exactly, so SlaAtRiskAnalyzer correlates both as causes of the SLA risk.
  await bulkInsert(pool, 'picking_tasks', ['task_id', 'order_id', 'picker_id', 'start_time', 'end_time', 'errors', 'distance_walked', 'status'], [[TEST_TASK, orderId, PICKER, toSql(addMinutes(t0, -75)), null, 0, null, 'IN_PROGRESS']]);
  const taskIdMap = await loadCodeToIdMap(pool, 'picking_tasks', 'task_id');
  await bulkInsert(pool, 'picking_task_items', ['task_id', 'sku', 'location', 'requested_quantity', 'picked_quantity', 'error_reason'], [[taskIdMap.get(TEST_TASK)!, TEST_SKU, 'A1', 5, 0, null]]);
}

async function seedLeadTimeOrder(t0: Date): Promise<void> {
  // Healthy stock -- this order is deliberately isolated from the shortage scenario above so
  // the only thing it demonstrates is prediction lead time, not the causal chain.
  await bulkInsert(
    pool,
    'products',
    ['sku', 'product_name', 'category', 'unit_weight', 'unit_length', 'unit_width', 'unit_height', 'reorder_level', 'active', 'created_at'],
    [[LEAD_TIME_SKU, 'Lead Time Test Widget', 'Test', 1, 5, 5, 5, 20, 1, toSql(addMinutes(t0, -60))]],
  );
  await bulkInsert(pool, 'inventory', ['sku', 'location', 'quantity', 'reserved_quantity', 'damaged_quantity', 'last_updated'], [[LEAD_TIME_SKU, 'A1', 100, 0, 0, toSql(addMinutes(t0, -30))]]);

  // 150min to dispatch: OUTSIDE thresholds.slaAtRisk.windowMinutes (120) -- SlaAtRiskRule's own
  // candidate filter will not select this order at all, so no SLA_AT_RISK exception fires.
  // But it IS inside thresholds.prediction.slaBreach.windowMinutes (240) -- SlaBreachPredictor's
  // wider, deliberately-earlier window -- so it IS scored. urgencyRatio (predictor's own, out of
  // 240) = 1 - 150/240 = 0.375 -> slaUrgency signal = 0.375*40 = 15. Plus PICKING_INCOMPLETE
  // (+25, nothing picked), PACKING_INCOMPLETE (+15, no packing record), ORDER_PRIORITY URGENT
  // (+10), ITEMS_PENDING (+10) = 75 -> HIGH risk band (thresholds.prediction.riskLevel: medium
  // 30, high 60, critical 80). No picking task is seeded, so PICKING_DELAY never fires either --
  // the only thing "at risk" here at T0 is the still-30-minute-safe SLA window, seen 150 minutes
  // in advance purely because the predictor's window is wider than the exception's.
  await bulkInsert(
    pool,
    'orders',
    ['order_id', 'customer_id', 'priority', 'order_time', 'expected_dispatch', 'status', 'created_at', 'updated_at'],
    [[LEAD_TIME_ORDER, CUSTOMER, 'URGENT', toSql(addMinutes(t0, -30)), toSql(addMinutes(t0, 150)), 'PICKING', toSql(addMinutes(t0, -30)), toSql(addMinutes(t0, -30))]],
  );
  const orderIdMap = await loadCodeToIdMap(pool, 'orders', 'order_id');
  await bulkInsert(pool, 'order_items', ['order_id', 'sku', 'quantity', 'picked_quantity', 'packed_quantity'], [[orderIdMap.get(LEAD_TIME_ORDER)!, LEAD_TIME_SKU, 5, 0, 0]]);
}

async function main(): Promise<void> {
  const t0 = resolveSimulationTime();

  logger.info('Cleaning up any previous run of this scenario...');
  await cleanupPrevious();

  logger.info('Seeding MIX-ORDER-001 (inventory shortage + SLA risk, same SKU)...');
  await seedOrder(t0);

  logger.info('Seeding MIX-ORDER-002 (lead-time proof: prediction ACTIVE, no exception yet)...');
  await seedLeadTimeOrder(t0);

  logger.info('Running exception detection (POST /exceptions/run)...');
  await post('/exceptions/run');

  const [exceptionRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, exception_id, exception_type, entity_type, entity_id, severity, status, evidence, detected_at FROM exceptions WHERE entity_id IN (?, ?, ?) AND status = 'OPEN'`,
    [TEST_ORDER, TEST_SKU, TEST_TASK],
  );
  const slaException = exceptionRows.find((r) => r.exception_type === 'SLA_AT_RISK');
  const shortageException = exceptionRows.find((r) => r.exception_type === 'INVENTORY_SHORTAGE');
  const pickingDelayException = exceptionRows.find((r) => r.exception_type === 'PICKING_DELAY');
  if (!slaException || !shortageException || !pickingDelayException) {
    throw new Error(`Expected SLA_AT_RISK + INVENTORY_SHORTAGE + PICKING_DELAY to be detected, got: ${JSON.stringify(exceptionRows)}`);
  }
  logger.info('Exceptions detected', {
    slaException: slaException.exception_id,
    shortageException: shortageException.exception_id,
    pickingDelayException: pickingDelayException.exception_id,
  });

  logger.info('Running prediction evaluation (POST /predictions/evaluate)...');
  await post('/predictions/evaluate');

  logger.info(`Running root-cause analysis (POST /exceptions/${slaException.id}/root-cause)...`);
  await post(`/exceptions/${slaException.id}/root-cause`);

  logger.info(`Running recommendation (POST /exceptions/${slaException.id}/recommendation)...`);
  await post(`/exceptions/${slaException.id}/recommendation`);

  // The evaluate run can produce more than one prediction type for this order (e.g. it's also
  // a DISPATCH_DELAY_RISK candidate) -- fetch all of them and single out SLA_BREACH_RISK, the
  // one this scenario is designed to demonstrate, rather than grabbing "whichever row sorted
  // last" (which silently picks the wrong type when two rows share the same predicted_at second).
  const [allPredictionRows] = await pool.query<RowDataPacket[]>(`SELECT prediction_id, prediction_type, entity_type, entity_id, risk_score, risk_level, status, signals, prediction_window_minutes, predicted_at FROM predictions WHERE entity_id = ? ORDER BY predicted_at`, [TEST_ORDER]);
  const predictionRows = allPredictionRows.filter((r) => r.prediction_type === 'SLA_BREACH_RISK');
  const otherPredictionRows = allPredictionRows.filter((r) => r.prediction_type !== 'SLA_BREACH_RISK');
  const [rootCauseRows] = await pool.query<RowDataPacket[]>(`SELECT analysis_id, primary_cause_type, primary_cause_score, primary_cause_confidence, result, analyzed_at FROM root_cause_analyses WHERE exception_id = ?`, [slaException.id]);
  const [recommendationRows] = await pool.query<RowDataPacket[]>(`SELECT recommendation_id, action_type, title, priority, status, result, analyzed_at FROM exception_recommendations WHERE exception_id = ?`, [slaException.id]);

  const parseJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
  const rootCauseResult = rootCauseRows[0] ? parseJson(rootCauseRows[0].result) : null;
  const recommendationResult = recommendationRows[0] ? parseJson(recommendationRows[0].result) : null;

  console.log('\n=== MIXED CASE RESULT: order', TEST_ORDER, '===\n');
  console.log('Exceptions:');
  console.table(exceptionRows.map((r) => ({ exception_id: r.exception_id, type: r.exception_type, entity_type: r.entity_type, entity_id: r.entity_id, severity: r.severity, status: r.status, detected_at: r.detected_at })));
  console.log('\nPrediction (SLA_BREACH_RISK):');
  console.table(predictionRows.map((r) => ({ prediction_id: r.prediction_id, type: r.prediction_type, entity_id: r.entity_id, risk_score: r.risk_score, risk_level: r.risk_level, status: r.status, window_min: r.prediction_window_minutes, predicted_at: r.predicted_at })));
  if (otherPredictionRows.length) console.log('  (other predictions also generated for this order:', otherPredictionRows.map((r) => `${r.prediction_type}=${r.risk_level}`).join(', '), ')');
  console.log('\nRoot cause (for the SLA_AT_RISK exception):');
  console.table(rootCauseRows.map((r) => ({ analysis_id: r.analysis_id, primary_cause: r.primary_cause_type, score: r.primary_cause_score, confidence: r.primary_cause_confidence })));
  console.log('  contributingCauses:', JSON.stringify(rootCauseResult?.contributingCauses ?? []));
  console.log('\nRecommendation(s) (for the SLA_AT_RISK exception):');
  console.table(recommendationRows.map((r) => ({ recommendation_id: r.recommendation_id, action_type: r.action_type, title: r.title, priority: r.priority, status: r.status })));
  console.log('  alternativeRecommendations:', JSON.stringify(recommendationResult?.alternativeRecommendations ?? []));

  console.log('\n--- Validation inputs (for manually checking correctness, not auto-graded) ---');
  console.log('t0 (script run time):', t0.toISOString());
  console.log('shortage evidence:', JSON.stringify(parseJson(shortageException.evidence)));
  console.log('sla evidence:', JSON.stringify(parseJson(slaException.evidence)));
  console.log('picking delay evidence:', JSON.stringify(parseJson(pickingDelayException.evidence)));
  console.log('prediction signals:', predictionRows[0] ? JSON.stringify(parseJson(predictionRows[0].signals)) : null);

  if (!predictionRows.length) logger.warn('No prediction row found -- check that the app is running and /predictions/evaluate succeeded.');
  if (!rootCauseRows.length) logger.warn('No root-cause row found.');
  if (!recommendationRows.length) logger.warn('No recommendation row found.');

  // ---- Lead-time proof (MIX-ORDER-002) ----
  const [leadTimeExceptionRows] = await pool.query<RowDataPacket[]>(`SELECT exception_id, exception_type, severity, status FROM exceptions WHERE entity_id IN (?, ?)`, [LEAD_TIME_ORDER, LEAD_TIME_SKU]);
  const [leadTimePredictionRows] = await pool.query<RowDataPacket[]>(
    `SELECT prediction_id, prediction_type, risk_score, risk_level, status, signals, predicted_at FROM predictions WHERE entity_id = ? AND prediction_type = 'SLA_BREACH_RISK'`,
    [LEAD_TIME_ORDER],
  );

  console.log('\n=== LEAD-TIME PROOF: order', LEAD_TIME_ORDER, '(150min to dispatch: outside the 120min exception window, inside the 240min prediction window) ===\n');
  console.log('Exceptions for this order (expected: none yet):');
  console.table(leadTimeExceptionRows);
  console.log('\nPrediction (SLA_BREACH_RISK, expected: ACTIVE, not CONFIRMED, since no exception exists to confirm):');
  console.table(leadTimePredictionRows.map((r) => ({ prediction_id: r.prediction_id, risk_score: r.risk_score, risk_level: r.risk_level, status: r.status, predicted_at: r.predicted_at })));
  if (leadTimePredictionRows[0]) console.log('  signals:', JSON.stringify(parseJson(leadTimePredictionRows[0].signals)));

  if (leadTimeExceptionRows.length > 0) {
    logger.warn('Expected MIX-ORDER-002 to have NO exceptions yet -- lead-time proof invalidated', { found: leadTimeExceptionRows });
  } else if (leadTimePredictionRows[0]?.status !== 'ACTIVE') {
    logger.warn('Expected the MIX-ORDER-002 prediction status to be ACTIVE (not CONFIRMED) -- lead-time proof invalidated', { found: leadTimePredictionRows[0] });
  } else {
    logger.info(`Lead time confirmed: prediction fired ${leadTimePredictionRows[0].risk_score >= 60 ? 'well' : ''} ahead of any exception -- ${150 - 120} minutes of margin before this order would even become an SLA_AT_RISK candidate, and the full 150 minutes before its actual dispatch deadline.`);
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    logger.error('mixed-case-scenario failed', { error: error instanceof Error ? error.stack : error });
    await closePool();
    process.exit(1);
  });
