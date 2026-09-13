import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * PREDICTION VALIDATION / BACKTESTING SUITE.
 *
 * Answers the business question this framework exists for: "does the prediction engine
 * detect upcoming WMS exceptions BEFORE they occur, with enough warning to matter?" — by
 * running the REAL PredictionEngine and ExceptionEngine (src/engine/*.ts) against 16
 * deterministic scenarios and comparing predictions to what the exception detector later
 * actually found.
 *
 * Mocking strategy mirrors the two existing "run the real engine offline" suites in this
 * repo (src/canonical/mock-pipeline.test.ts, src/predictors/prediction-scenarios.test.ts):
 * `../adapters` is replaced with a MockLogisticsDataSource instance we control directly, and
 * `../repositories` is replaced with in-memory fakes (src/validation/fakes.ts) so nothing
 * here ever opens the real MySQL pool or touches the production `exceptions`/`predictions`
 * tables (Section 20 — database safety).
 */
vi.mock('../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});
vi.mock('../repositories', async () => {
  const { fakeExceptionRepository, fakePredictionRepository } = await import('./fakes');
  return { exceptionRepository: fakeExceptionRepository, predictionRepository: fakePredictionRepository };
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logisticsDataSource } from '../adapters';
import { MockLogisticsDataSource } from '../adapters/mock';
import { ValidationReport } from './metrics';
import { formatValidationReport } from './report-formatter';
import { runValidationSuite } from './run-suite';
import { ScenarioResult } from './types';

const dataSource = logisticsDataSource as unknown as MockLogisticsDataSource;

async function runSuiteWithFakeClock(): Promise<{ report: ValidationReport; results: ScenarioResult[] }> {
  vi.useFakeTimers();
  try {
    return await runValidationSuite({ dataSource, setSystemTime: (d) => vi.setSystemTime(d) });
  } finally {
    vi.useRealTimers();
  }
}

let report: ValidationReport;
let results: ScenarioResult[];

function find(scenarioId: string, targetIndex = 0): ScenarioResult {
  const match = results.find((r) => r.scenarioId === scenarioId && r.targetIndex === targetIndex);
  if (!match) throw new Error(`No scenario result for ${scenarioId}/${targetIndex}`);
  return match;
}

describe('Prediction Validation / Backtesting Suite', () => {
  beforeAll(async () => {
    const suite = await runSuiteWithFakeClock();
    report = suite.report;
    results = suite.results;
  });

  afterAll(() => {
    const text = formatValidationReport(report);
    // eslint-disable-next-line no-console
    console.log(`\n${text}\n`);

    const reportsDir = path.join(__dirname, '..', '..', 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, 'prediction-validation-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(reportsDir, 'prediction-validation-report.txt'), text);
  });

  it('every scenario result matches its declared expected outcome (Section 39 checklist)', () => {
    const failures = results
      .filter((r) => !r.passed)
      .map((r) => `${r.scenarioId}/${r.targetIndex} (${r.scenarioName}, ${r.predictionType}): expected ${r.expectedResult}, got ${r.validation.result}`);
    expect(failures).toEqual([]);
  });

  // ---- Section 32: the 15 required automated test cases, each backed by a real scenario run ----

  it('1. prediction created before the exception occurs -> TRUE_POSITIVE (S02)', () => {
    const r = find('S02');
    expect(r.validation.result).toBe('TRUE_POSITIVE');
    expect(r.prediction).not.toBeNull();
    expect(r.actualOutcome.exceptionTimestamp).not.toBeNull();
    expect(r.prediction!.predictedAt.getTime()).toBeLessThan(r.actualOutcome.exceptionTimestamp!.getTime());
  });

  it('2. an exception that already existed before the prediction is never a TRUE_POSITIVE (S11)', () => {
    const r = find('S11');
    expect(r.validation.result).toBe('CONFIRMED_BEFORE_PREDICTION');
    expect(r.validation.result).not.toBe('TRUE_POSITIVE');
  });

  it('3. prediction made, no matching exception ever occurs -> FALSE_POSITIVE (S05, S09)', () => {
    expect(find('S05').validation.result).toBe('FALSE_POSITIVE');
    expect(find('S09').validation.result).toBe('FALSE_POSITIVE');
  });

  it('4. exception occurs with no preceding prediction -> FALSE_NEGATIVE (S16, live end-to-end)', () => {
    // S16 is a genuine gap in the real PickingDelayPredictor, not a fabricated one: with no
    // historical baseline, no linked order, no item complexity and no errors, the only
    // signal that can ever fire (ELAPSED_VS_STUCK_THRESHOLD) caps at 20 — below the MEDIUM
    // risk bar (30) — so no meaningful prediction is ever persisted, even though the real
    // PredictionEngine evaluated the task on every run. PickingDelayRule fires on the same
    // fixed 60-minute stuck threshold regardless of baseline availability, so PICKING_DELAY
    // still opens. The pure-logic matching case in matching.test.ts ("exception with no
    // preceding prediction") proves the same code path in isolation.
    const r = find('S16');
    expect(r.validation.result).toBe('FALSE_NEGATIVE');
    expect(r.prediction).toBeNull();
    expect(r.actualOutcome.exceptionOccurred).toBe(true);
  });

  it('5. no prediction and no exception -> TRUE_NEGATIVE (S01, S07, S15)', () => {
    expect(find('S01').validation.result).toBe('TRUE_NEGATIVE');
    expect(find('S07').validation.result).toBe('TRUE_NEGATIVE');
    expect(find('S15').validation.result).toBe('TRUE_NEGATIVE');
  });

  it('6. missing required data -> NOT_MEASURABLE, never a fabricated LOW-risk score (S12)', () => {
    const r = find('S12');
    expect(r.validation.result).toBe('NOT_MEASURABLE');
    expect(r.prediction).toBeNull();
  });

  it('7. warning time is calculated precisely, including sub-minute precision (S14: 30-second warning)', () => {
    const r = find('S14');
    expect(r.validation.result).toBe('TRUE_POSITIVE');
    expect(r.validation.warningTimeMinutes).toBeCloseTo(0.5, 6);
    expect(r.validation.warningQuality).toBe('TOO_LATE');
  });

  it('8. prediction-window matching is respected (S06: no window still matches any future exception; S04: window-bound match)', () => {
    expect(find('S06').prediction?.predictionWindow).toBeNull();
    expect(find('S06').validation.result).toBe('TRUE_POSITIVE');
    expect(find('S04').validation.result).toBe('TRUE_POSITIVE');
  });

  it('9. multiple evaluations of the same entity collapse into one episode, not duplicate predictions (S04)', () => {
    const r = find('S04');
    expect(r.prediction).not.toBeNull();
    expect(r.prediction!.observationCount).toBeGreaterThan(1);
  });

  it('10. already-confirmed exception is distinguished from a genuine future prediction (S11)', () => {
    const r = find('S11');
    expect(r.prediction?.finalStatus).toBe('CONFIRMED');
    expect(r.validation.result).toBe('CONFIRMED_BEFORE_PREDICTION');
  });

  it('11. idempotent execution: re-running the engines at the same instant creates no duplicate rows (S13)', () => {
    const r = find('S13');
    expect(r.idempotencyPassed).toBe(true);
  });

  it('12. aggregate metrics match the underlying scenario results on this run', () => {
    const tp = results.filter((r) => r.validation.result === 'TRUE_POSITIVE').length;
    const fp = results.filter((r) => r.validation.result === 'FALSE_POSITIVE').length;
    expect(report.summary.truePositives).toBe(tp);
    expect(report.summary.falsePositives).toBe(fp);
    if (tp + fp > 0) expect(report.summary.precision).toBeCloseTo(tp / (tp + fp), 10);
  });

  it('13. division-by-zero never produces NaN or a misleading percentage', () => {
    for (const value of [report.summary.precision, report.summary.recall, report.summary.f1Score, report.summary.falsePositiveRate]) {
      if (value !== null) expect(Number.isNaN(value)).toBe(false);
    }
  });

  it('14. the whole suite is deterministic — re-running it produces byte-identical classifications', async () => {
    const rerun = await runSuiteWithFakeClock();
    expect(rerun.results.map((r) => ({ scenarioId: r.scenarioId, targetIndex: r.targetIndex, result: r.validation.result, warningTimeMinutes: r.validation.warningTimeMinutes }))).toEqual(
      results.map((r) => ({ scenarioId: r.scenarioId, targetIndex: r.targetIndex, result: r.validation.result, warningTimeMinutes: r.validation.warningTimeMinutes })),
    );
    expect(rerun.report.summary).toEqual(report.summary);
  });

  it('15. no future-data leakage: the prediction never references the exception it precedes (S02)', () => {
    const r = find('S02');
    expect(r.prediction).not.toBeNull();
    expect(r.actualOutcome.exceptionId).not.toBeNull();
    // The prediction's signals/explanation are captured at predictedAt, strictly before the
    // exception (assertion 1 above already proves the ordering) — this additionally proves
    // the prediction's own content contains no reference to the (not-yet-existing) exception.
    expect(JSON.stringify(r.prediction!.signals) + r.prediction!.explanation).not.toContain(r.actualOutcome.exceptionId as string);
  });
});
