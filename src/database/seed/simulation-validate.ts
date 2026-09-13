import * as fs from 'node:fs';
import * as path from 'node:path';
import { RowDataPacket } from 'mysql2/promise';
import { pool, closePool } from '../pool';
import { logger } from '../../utils/logger';
import { runDataQualityChecks, checkNoLeakageAtSeedTime } from './validate';
import { buildScenarioTargetsManifest } from './controlled-scenarios';

/**
 * `npm run simulation:validate` — re-runs data-quality validation against whatever is
 * currently in the database, prints the CURRENT live state of every controlled scenario's
 * prediction/exception rows, and replays the authoritative TP/FP/FN/TN/warning-time
 * measurement that `npm run db:seed` captured and wrote to
 * reports/live-seed-validation-report.json at seed time.
 *
 * Note on why this command does not RE-DERIVE warning times itself: `predictions.predicted_at`
 * is legitimately overwritten every time POST /predictions/evaluate runs again (exactly like
 * real production use — this system keeps no prediction history/audit table). The seed run
 * captures the correct "first observed" predicted_at in-process, before any later evaluate
 * call can overwrite it (see report.ts), and persists that measurement to the JSON report
 * above. Running this command long after seeding can still show a scenario's CURRENT state
 * (has the exception fired yet? what does the live prediction row say right now?) but cannot
 * safely re-compute a warning time from a possibly-since-overwritten predicted_at.
 */
async function main(): Promise<void> {
  const quality = await runDataQualityChecks(pool);
  // eslint-disable-next-line no-console
  console.log('\n--- DATA QUALITY VALIDATION (current state) ---');
  for (const c of quality) {
    // eslint-disable-next-line no-console
    console.log(`[${c.passed ? 'PASS' : 'FAIL'}] ${c.check} :: ${c.detail}`);
  }

  const targets = buildScenarioTargetsManifest();

  // eslint-disable-next-line no-console
  console.log('\n--- CONTROLLED SCENARIOS: CURRENT LIVE STATE ---');
  for (const t of targets) {
    const [predRows] = await pool.query<RowDataPacket[]>(
      t.predictionType ? 'SELECT status, risk_level, predicted_at, confirmed_exception_id FROM predictions WHERE prediction_type = ? AND entity_type = ? AND entity_id = ? ORDER BY predicted_at DESC LIMIT 1' : 'SELECT 1 FROM DUAL WHERE 1=0',
      t.predictionType ? [t.predictionType, t.entityType, t.entityId] : [],
    );
    const [excRows] = await pool.query<RowDataPacket[]>(
      t.exceptionType ? "SELECT status, detected_at FROM exceptions WHERE exception_type = ? AND entity_type = ? AND entity_id = ? ORDER BY detected_at ASC" : 'SELECT 1 FROM DUAL WHERE 1=0',
      t.exceptionType ? [t.exceptionType, t.entityType, t.entityId] : [],
    );
    const pred = predRows[0];
    const exc = excRows[0];
    // eslint-disable-next-line no-console
    console.log(
      `${t.scenarioId.padEnd(4)} ${t.category.padEnd(32)} entity=${t.entityId.padEnd(14)} prediction=${pred ? `${pred.status}/${pred.risk_level}@${new Date(pred.predicted_at as Date).toISOString()}` : 'NONE'}  exception=${exc ? `${exc.status}@${new Date(exc.detected_at as Date).toISOString()}` : 'NONE (not yet detected)'}  expected=${t.expectedResult}`,
    );
  }

  const leakage = await checkNoLeakageAtSeedTime(pool, targets.filter((t) => t.expectedResult === 'CONFIRMED_BEFORE_PREDICTION'));
  void leakage; // leakage is only meaningful at seed time (see checkNoLeakageAtSeedTime's own doc) -- skipped here on purpose.

  const reportPath = path.join(__dirname, '..', '..', '..', 'reports', 'live-seed-validation-report.json');
  if (fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    // eslint-disable-next-line no-console
    console.log('\n--- AUTHORITATIVE MEASUREMENT FROM LAST `npm run db:seed` RUN ---');
    // eslint-disable-next-line no-console
    console.log(`(captured at T0 = ${report.t0}; see reports/live-seed-validation-report.json for full detail)`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report.summary, null, 2));
  } else {
    logger.warn('No reports/live-seed-validation-report.json found -- run `npm run db:seed` first for an authoritative TP/FP/FN/TN measurement.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    logger.error('simulation:validate failed', { error: error instanceof Error ? error.stack : error });
    await closePool();
    process.exit(1);
  });
