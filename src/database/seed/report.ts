import { Pool, RowDataPacket } from 'mysql2/promise';
import { classifyWarningQuality, evaluatePrediction, isMeaningfulRiskLevel } from '../../validation/matching';
import { ExceptionSnapshot, PredictionSnapshot, ValidationResult } from '../../validation/types';
import { ScenarioTarget } from './controlled-scenarios';

/**
 * Live measurement layer for the 15 controlled scenarios -- the real-DB counterpart of
 * src/validation's fake-timer suite. Reuses the SAME pure matching/warning-quality functions
 * (src/validation/matching.ts) rather than re-implementing the TP/FP/FN/TN/window/episode
 * rules a second time; only the data source differs (real `predictions`/`exceptions` rows
 * instead of in-memory fakes).
 */

export interface ScenarioMeasurement {
  scenarioId: string;
  category: string;
  predictionType: string | null;
  entityType: string;
  entityId: string;
  prediction: PredictionSnapshot | null;
  actualException: ExceptionSnapshot | null;
  result: ValidationResult;
  warningTimeMinutes: number | null;
  warningQuality: string;
  expectedResult: string;
  passed: boolean;
  notes: string;
  longHorizon: boolean;
}

interface PredictionRow extends RowDataPacket {
  prediction_id: string;
  prediction_type: string;
  entity_type: string;
  entity_id: string;
  risk_score: number | null;
  risk_level: string;
  confidence: string | null;
  status: string;
  prediction_window_minutes: number | null;
  signals: string;
  explanation: string;
  confirmed_exception_id: string | null;
  predicted_at: Date;
}

/** mysql2/MariaDB sometimes returns a LONGTEXT-with-CHECK(json_valid()) column (this is what
 *  MariaDB's `JSON` type actually is) already parsed rather than as a raw string, depending on
 *  the driver's column-metadata detection — see the same defensive check already in
 *  src/repositories/prediction.repository.ts's parseJsonColumn. */
function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function toSnapshot(row: PredictionRow): PredictionSnapshot {
  return {
    predictionId: row.prediction_id,
    predictionType: row.prediction_type as PredictionSnapshot['predictionType'],
    entityType: row.entity_type as PredictionSnapshot['entityType'],
    entityId: row.entity_id,
    predictedAt: new Date(row.predicted_at),
    riskScore: row.risk_score,
    riskLevel: row.risk_level as PredictionSnapshot['riskLevel'],
    highestRiskScore: row.risk_score,
    confidence: row.confidence as PredictionSnapshot['confidence'],
    predictionWindow: row.prediction_window_minutes !== null ? { value: row.prediction_window_minutes, unit: 'MINUTES' } : null,
    signals: parseJsonColumn(row.signals, []),
    explanation: row.explanation,
    finalStatus: row.status as PredictionSnapshot['finalStatus'],
    confirmedExceptionId: row.confirmed_exception_id,
    observationCount: 1,
  };
}

/** Snapshots every VAL-* prediction row RIGHT NOW -- call this immediately after the T0
 *  prediction-evaluation pass and before any later re-evaluation, since a later
 *  /predictions/evaluate call legitimately overwrites predicted_at on the live row (exactly
 *  like real production use) -- this snapshot is what preserves "the prediction as first
 *  observed" for warning-time math, the same guarantee PredictionSnapshot documents.
 *
 *  Only rows at MEDIUM+ risk are kept (isMeaningfulRiskLevel, validationConfig.ts's policy):
 *  every predictor persists a row for EVERY candidate regardless of risk (documented in
 *  validation-config.ts), so a LOW-risk row is not a warning an operator would ever act on
 *  and must not count as "a prediction was made" here -- exactly the same interpretation
 *  the fake-timer suite (src/validation/) already applies. Without this filter, a task/SKU
 *  the predictor correctly scored as low-risk gets miscounted as a false positive the moment
 *  no exception follows it. */
export async function capturePredictionSnapshots(pool: Pool, targets: ScenarioTarget[]): Promise<Map<string, PredictionSnapshot>> {
  const map = new Map<string, PredictionSnapshot>();
  for (const t of targets) {
    if (!t.predictionType) continue;
    const [rows] = await pool.query<PredictionRow[]>(
      `SELECT * FROM predictions WHERE prediction_type = ? AND entity_type = ? AND entity_id = ? ORDER BY predicted_at DESC LIMIT 1`,
      [t.predictionType, t.entityType, t.entityId],
    );
    if (rows[0] && isMeaningfulRiskLevel(rows[0].risk_level as PredictionSnapshot['riskLevel'])) {
      map.set(`${t.scenarioId}|${t.entityType}|${t.entityId}`, toSnapshot(rows[0]));
    }
  }
  return map;
}

export async function measureScenarios(pool: Pool, targets: ScenarioTarget[], predictionSnapshots: Map<string, PredictionSnapshot>, simulationEndTime: Date): Promise<ScenarioMeasurement[]> {
  const out: ScenarioMeasurement[] = [];
  for (const t of targets) {
    const prediction = t.predictionType ? predictionSnapshots.get(`${t.scenarioId}|${t.entityType}|${t.entityId}`) ?? null : null;

    let candidates: ExceptionSnapshot[] = [];
    if (t.exceptionType) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT exception_id, exception_type, entity_type, entity_id, detected_at FROM exceptions WHERE exception_type = ? AND entity_type = ? AND entity_id = ? ORDER BY detected_at ASC`,
        [t.exceptionType, t.entityType, t.entityId],
      );
      candidates = rows.map((r) => ({ exceptionId: r.exception_id as string, type: r.exception_type as ExceptionSnapshot['type'], entityType: r.entity_type as ExceptionSnapshot['entityType'], entityId: r.entity_id as string, detectedAt: new Date(r.detected_at as Date) }));
    }

    if (t.expectedResult === 'NOT_MEASURABLE') {
      out.push({ scenarioId: t.scenarioId, category: t.category, predictionType: t.predictionType, entityType: t.entityType, entityId: t.entityId, prediction: null, actualException: null, result: 'NOT_MEASURABLE', warningTimeMinutes: null, warningQuality: 'NOT_APPLICABLE', expectedResult: t.expectedResult, passed: true, notes: t.notes, longHorizon: false });
      continue;
    }

    const outcome = evaluatePrediction({ prediction, candidateExceptions: candidates, simulationEndTime });
    // A long-horizon scenario (S3) cannot reach its true designed outcome inside this run's
    // short real-time observation window (see ScenarioTarget.longHorizon). If no exception has
    // been observed yet, "TRUE_NEGATIVE" would dishonestly claim we know none is coming -- we
    // don't, we simply haven't waited long enough. PENDING ("evaluation horizon has not
    // completed yet") is the correct classification here, and it already falls outside the
    // TP/FP/FN/TN tally computed by summarizeMeasurements below. Any OTHER outcome for a
    // longHorizon scenario (TP, FP, FN, CONFIRMED_BEFORE_PREDICTION) is a real, already-observed
    // fact and is left exactly as evaluatePrediction determined it -- never downgraded.
    const result = t.longHorizon && outcome.result === 'TRUE_NEGATIVE' ? 'PENDING' : outcome.result;
    out.push({
      scenarioId: t.scenarioId,
      category: t.category,
      predictionType: t.predictionType,
      entityType: t.entityType,
      entityId: t.entityId,
      prediction,
      actualException: outcome.matchedException ?? candidates[0] ?? null,
      result,
      warningTimeMinutes: outcome.warningTimeMinutes,
      warningQuality: classifyWarningQuality(outcome.warningTimeMinutes, result),
      expectedResult: t.expectedResult,
      // A long-horizon scenario is not graded against expectedResult here -- see the PENDING
      // override above; its true outcome is only ever resolvable by the deterministic mock
      // suite (npm run prediction:validate), which has no real-time budget constraint.
      passed: t.longHorizon ? true : result === t.expectedResult,
      notes: t.notes,
      longHorizon: t.longHorizon ?? false,
    });
  }
  return out;
}

export interface LiveMetricsSummary {
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
}

export function summarizeMeasurements(measurements: ScenarioMeasurement[]): LiveMetricsSummary {
  const tp = measurements.filter((m) => m.result === 'TRUE_POSITIVE').length;
  const fp = measurements.filter((m) => m.result === 'FALSE_POSITIVE').length;
  const fn = measurements.filter((m) => m.result === 'FALSE_NEGATIVE').length;
  const tn = measurements.filter((m) => m.result === 'TRUE_NEGATIVE').length;
  const confirmed = measurements.filter((m) => m.result === 'CONFIRMED_BEFORE_PREDICTION').length;
  const notMeasurable = measurements.filter((m) => m.result === 'NOT_MEASURABLE').length;
  const pending = measurements.filter((m) => m.result === 'PENDING').length;
  const warningTimes = measurements.filter((m) => m.result === 'TRUE_POSITIVE' && m.warningTimeMinutes !== null).map((m) => m.warningTimeMinutes as number);

  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const falsePositiveRate = fp + tn > 0 ? fp / (fp + tn) : null;

  return { total: measurements.length, truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn, confirmedBeforePrediction: confirmed, notMeasurable, pending, precision, recall, f1, falsePositiveRate, warningTimes };
}
