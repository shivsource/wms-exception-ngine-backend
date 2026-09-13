import * as fs from 'node:fs';
import * as path from 'node:path';
import { pool, closePool } from '../pool';
import { logger } from '../../utils/logger';
import { resetDatabase } from './reset';
import { resolveSimulationTime } from './time';
import { seedGeneralDataset } from './general-dataset';
import { seedControlledScenarios } from './controlled-scenarios';
import { runDataQualityChecks, checkNoLeakageAtSeedTime, CheckResult } from './validate';
import { capturePredictionSnapshots, measureScenarios, summarizeMeasurements, ScenarioMeasurement } from './report';
import { printSeedSummary } from './summary';
import { checkAppReachable, evaluatePredictionEntity, runExceptionDetection, runPredictionEvaluation, sleep } from './live-api';

/**
 * Full seed pipeline: reset -> general dataset -> 15 controlled scenarios -> data-quality
 * validation -> T0 prediction capture (via the live, unmodified app) -> a short real wait ->
 * T1 state changes for the scenarios that need one -> a further real wait for the
 * time-threshold scenarios to cross their thresholds live -> final measurement + report.
 *
 * This is `npm run db:seed`. See Step 20/21/22 of the brief this was built from for why the
 * live app's own POST /predictions/evaluate and POST /exceptions/run endpoints are used
 * (src/database/seed/live-api.ts) instead of re-instantiating the engines here: it proves the
 * REAL, unmodified engines demonstrate genuine pre-exception prediction, not a copy of them.
 */
function printChecks(title: string, checks: CheckResult[]): void {
  // eslint-disable-next-line no-console
  console.log(`\n--- ${title} ---`);
  for (const c of checks) {
    // eslint-disable-next-line no-console
    console.log(`[${c.passed ? 'PASS' : 'FAIL'}] ${c.check} :: ${c.detail}`);
  }
}

function printScenarioReport(measurements: ScenarioMeasurement[]): void {
  // eslint-disable-next-line no-console
  console.log('\n--- CONTROLLED SCENARIO RESULTS (live, real DB) ---');
  for (const m of measurements) {
    const predAt = m.prediction ? m.prediction.predictedAt.toISOString() : 'NONE';
    const excAt = m.actualException ? m.actualException.detectedAt.toISOString() : 'NONE';
    const warn = m.warningTimeMinutes !== null ? `${m.warningTimeMinutes.toFixed(2)}min (${m.warningQuality})` : 'n/a';
    const verdict = m.longHorizon ? 'NOT GRADED (long-horizon -- see note)' : m.passed ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(`${m.scenarioId.padEnd(4)} ${m.category.padEnd(30)} pred=${predAt} exc=${excAt} warning=${warn} -> ${m.result} (expected ${m.expectedResult}) ${verdict}`);
    if (m.longHorizon) {
      // eslint-disable-next-line no-console
      console.log(`     NOTE: ${m.notes}`);
    }
  }
}

async function main(): Promise<void> {
  const t0 = resolveSimulationTime();
  logger.info('Seed run starting', { t0: t0.toISOString() });

  const appReachable = await checkAppReachable();
  if (!appReachable) {
    throw new Error('The app server is not reachable at SEED_APP_URL (default http://localhost:6000). Start it first (docker compose up / npm run dev) -- the seed needs it to trigger real prediction/exception evaluations.');
  }

  await resetDatabase(pool);
  const general = await seedGeneralDataset(pool, t0);
  const { targets, advanceSteps } = await seedControlledScenarios(pool, t0);

  const qualityChecks = await runDataQualityChecks(pool);
  printChecks('DATA QUALITY VALIDATION (Step 17)', qualityChecks);

  const leakageChecks = await checkNoLeakageAtSeedTime(pool, targets);
  printChecks('FUTURE-DATA LEAKAGE VALIDATION (Step 18, checked before any prediction ever runs)', leakageChecks);

  logger.info('Phase T0: triggering the live prediction engine (POST /predictions/evaluate)');
  await runPredictionEvaluation();
  await evaluatePredictionEntity('ORDER', 'VAL-ORD-011'); // S15: explicit per-entity call to exercise evaluateOne's INSUFFICIENT_DATA path

  const t0Snapshots = await capturePredictionSnapshots(pool, targets);
  logger.info(`Captured ${t0Snapshots.size} T0 prediction snapshot(s) for controlled scenarios`);

  logger.info('Waiting ~60s (a real, deliberate T0->T1 gap) before applying state-changing events...');
  await sleep(60_000);

  logger.info(`Applying ${advanceSteps.length} T1 state-changing event(s)`);
  for (const step of advanceSteps) {
    logger.info(`  [${step.scenarioId}] ${step.description}`);
    await step.apply(pool);
  }

  logger.info('Triggering exception detection immediately after T1 events (POST /exceptions/run)');
  await runExceptionDetection();

  logger.info('Waiting ~4 more real minutes for the time-threshold scenarios (S1/S9/S11/S13) to cross their live thresholds...');
  await sleep(4 * 60_000);

  logger.info('Final exception detection + prediction pass');
  await runExceptionDetection();
  await runPredictionEvaluation();

  const simulationEndTime = new Date();
  const measurements = await measureScenarios(pool, targets, t0Snapshots, simulationEndTime);
  printScenarioReport(measurements);

  const summary = summarizeMeasurements(measurements);
  // eslint-disable-next-line no-console
  console.log('\n--- LIVE METRICS SUMMARY ---');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  await printSeedSummary(pool, t0, general, targets);

  const reportsDir = path.join(__dirname, '..', '..', '..', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'live-seed-validation-report.json'), JSON.stringify({ t0, qualityChecks, leakageChecks, measurements, summary }, null, 2));
  logger.info('Wrote reports/live-seed-validation-report.json');

  const failed = measurements.filter((m) => !m.passed);
  const failedChecks = [...qualityChecks, ...leakageChecks].filter((c) => !c.passed);
  if (failed.length > 0 || failedChecks.length > 0) {
    logger.error('Seed completed but some checks/scenarios did not match expectations', { failedScenarios: failed.map((f) => f.scenarioId), failedChecks: failedChecks.map((f) => f.check) });
  } else {
    logger.info('Seed completed: all data-quality checks, leakage checks, and controlled scenarios passed.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    logger.error('Seed run failed', { error: error instanceof Error ? error.stack : error });
    await closePool();
    process.exit(1);
  });
