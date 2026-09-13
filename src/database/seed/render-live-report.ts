import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `npm run validate:live` — renders reports/live-seed-validation-report.json (written once,
 * at the end of the last `npm run db:seed` run) as the scenario-level table + aggregate
 * metrics the validation brief asks for. Pure read/format: no DB connection, no engine call,
 * no re-evaluation. This is deliberate -- see simulation-validate.ts's doc comment for why
 * warning times can only safely be read from this frozen, seed-time snapshot: predicted_at on
 * the live `predictions` rows is legitimately overwritten by every subsequent
 * POST /predictions/evaluate call (including the SCHEDULER_CRON tick), so re-querying the
 * database after the fact can no longer answer "how much warning did this prediction give?"
 */

interface Measurement {
  scenarioId: string;
  category: string;
  predictionType: string | null;
  entityType: string;
  entityId: string;
  prediction: { predictedAt: string } | null;
  actualException: { detectedAt: string } | null;
  result: string;
  warningTimeMinutes: number | null;
  expectedResult: string;
  passed: boolean;
  longHorizon: boolean;
  notes: string;
}

interface LiveReport {
  t0: string;
  measurements: Measurement[];
  summary: {
    total: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    confirmedBeforePrediction: number;
    notMeasurable: number;
    pending: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    falsePositiveRate: number | null;
    warningTimes: number[];
  };
}

function pct(v: number | null): string {
  return v === null ? 'N/A' : `${(v * 100).toFixed(1)}%`;
}

function warn(m: Measurement): string {
  if (m.warningTimeMinutes === null) return '-';
  return `${m.warningTimeMinutes.toFixed(1)}m`;
}

function stat(values: number[], fn: (xs: number[]) => number): string {
  return values.length === 0 ? 'N/A' : `${fn(values).toFixed(1)} min`;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function main(): void {
  const reportPath = path.join(__dirname, '..', '..', '..', 'reports', 'live-seed-validation-report.json');
  if (!fs.existsSync(reportPath)) {
    // eslint-disable-next-line no-console
    console.error('reports/live-seed-validation-report.json not found. Run `npm run db:seed` once against a live app+DB to produce it -- this command only renders that frozen snapshot, it does not regenerate data.');
    process.exit(1);
  }
  const report: LiveReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));

  // eslint-disable-next-line no-console
  console.log('='.repeat(100));
  console.log('LIVE (REAL DATABASE) PREDICTION VALIDATION -- controlled VAL-ORD-*/VAL-PICK-*/VAL-SKU-* scenarios');
  console.log(`Captured at seed T0 = ${report.t0} (frozen snapshot -- see render-live-report.ts doc comment)`);
  console.log('='.repeat(100));
  console.log('');

  const header = ['Scenario', 'Entity', 'Type', 'Predicted At', 'Actual At', 'Classification', 'Expected', 'Warning', 'Verdict'];
  const rows = report.measurements.map((m) => [
    m.scenarioId,
    m.entityId,
    m.predictionType ?? '-',
    m.prediction ? m.prediction.predictedAt : 'NONE',
    m.actualException ? m.actualException.detectedAt : 'NONE',
    m.result,
    m.expectedResult,
    warn(m),
    m.longHorizon ? 'NOT GRADED*' : m.passed ? 'PASS' : 'FAIL',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const printRow = (cells: string[]): void => {
    // eslint-disable-next-line no-console
    console.log(cells.map((c, i) => c.padEnd(widths[i]!)).join(' | '));
  };
  printRow(header);
  // eslint-disable-next-line no-console
  console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
  rows.forEach(printRow);

  const longHorizon = report.measurements.filter((m) => m.longHorizon);
  if (longHorizon.length > 0) {
    // eslint-disable-next-line no-console
    console.log('');
    console.log(`* NOT GRADED = long-horizon scenario, designed outcome had not arrived yet within this run's real-time observation window:`);
    for (const m of longHorizon) {
      // eslint-disable-next-line no-console
      console.log(`  ${m.scenarioId} (${m.entityId}): ${m.notes}`);
    }
  }

  const s = report.summary;
  // eslint-disable-next-line no-console
  console.log('');
  console.log('-'.repeat(100));
  console.log('AGGREGATE METRICS (excludes NOT_MEASURABLE, PENDING, and CONFIRMED_BEFORE_PREDICTION by definition)');
  console.log('-'.repeat(100));
  console.log(`TP=${s.truePositives}  FP=${s.falsePositives}  FN=${s.falseNegatives}  TN=${s.trueNegatives}  CONFIRMED_BEFORE_PREDICTION=${s.confirmedBeforePrediction}  NOT_MEASURABLE=${s.notMeasurable}  PENDING=${s.pending}`);
  console.log(`Precision:            ${pct(s.precision)}`);
  console.log(`Recall:               ${pct(s.recall)}`);
  console.log(`F1:                   ${pct(s.f1 === null ? null : s.f1)}`);
  console.log(`False Positive Rate:  ${pct(s.falsePositiveRate)}`);
  console.log('');
  console.log(`Warning time (TRUE_POSITIVE only, n=${s.warningTimes.length}):`);
  console.log(`  average: ${stat(s.warningTimes, mean)}`);
  console.log(`  median:  ${stat(s.warningTimes, median)}`);
  console.log(`  min:     ${s.warningTimes.length ? `${Math.min(...s.warningTimes).toFixed(1)} min` : 'N/A'}`);
  console.log(`  max:     ${s.warningTimes.length ? `${Math.max(...s.warningTimes).toFixed(1)} min` : 'N/A'}`);
  console.log('');
  console.log('NOTE: this is a small (15-scenario) controlled-DB sample, not a statistically representative');
  console.log('production evaluation. See the mock-based suite (`npm run prediction:validate`) for the broader');
  console.log('16-scenario deterministic suite covering additional edge cases (idempotency, insufficient data,');
  console.log('multi-risk orders, etc).');
}

main();
