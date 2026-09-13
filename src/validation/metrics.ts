import { PredictionType } from '../types/enums';
import { ScenarioResult, ValidationResult } from './types';
import { validationConfig } from './validation-config';

/** Null (never NaN or a misleading 0%) whenever the denominator is zero (Section 12). */
function safeDivide(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

export interface ConfusionMatrix {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
}

export interface WarningTimeStats {
  count: number;
  averageMinutes: number | null;
  medianMinutes: number | null;
  minMinutes: number | null;
  maxMinutes: number | null;
  p25Minutes: number | null;
  p75Minutes: number | null;
}

export interface QualityMetrics {
  precision: number | null;
  recall: number | null;
  f1Score: number | null;
  falsePositiveRate: number | null;
}

export interface PredictionTypeMetrics extends ConfusionMatrix, QualityMetrics {
  predictionType: PredictionType;
  totalPredictions: number;
  notMeasurable: number;
  confirmedBeforePrediction: number;
  pending: number;
  warningTime: WarningTimeStats;
}

export interface OperationalUsefulness {
  pctOver30Min: number | null;
  pctOver60Min: number | null;
  pctUnder5Min: number | null;
}

export interface ValidationSummary extends ConfusionMatrix, QualityMetrics {
  totalScenarioResults: number;
  totalPredictions: number;
  notMeasurable: number;
  confirmedBeforePrediction: number;
  pending: number;
  warningTime: WarningTimeStats;
  operationalUsefulness: OperationalUsefulness;
  warningTimeBuckets: Record<string, number>;
}

export interface ValidationReport {
  generatedAt: Date;
  sampleSizeDisclaimer: string;
  summary: ValidationSummary;
  byPredictionType: Record<PredictionType, PredictionTypeMetrics>;
  scenarioResults: ScenarioResult[];
  interpretation: {
    accuracy: string;
    earlyWarningQuality: string;
    coverage: string;
    dataLimitations: string;
    sampleSizeWarning: string;
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] as number;
  const rank = p * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] as number;
  const upper = sorted[upperIndex] as number;
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

export function computeWarningTimeStats(results: ScenarioResult[]): WarningTimeStats {
  const times = results
    .filter((r) => r.validation.result === 'TRUE_POSITIVE' && r.validation.warningTimeMinutes !== null)
    .map((r) => r.validation.warningTimeMinutes as number)
    .sort((a, b) => a - b);

  if (times.length === 0) {
    return { count: 0, averageMinutes: null, medianMinutes: null, minMinutes: null, maxMinutes: null, p25Minutes: null, p75Minutes: null };
  }

  const sum = times.reduce((acc, t) => acc + t, 0);
  return {
    count: times.length,
    averageMinutes: sum / times.length,
    medianMinutes: percentile(times, 0.5),
    minMinutes: times[0] as number,
    maxMinutes: times[times.length - 1] as number,
    p25Minutes: percentile(times, 0.25),
    p75Minutes: percentile(times, 0.75),
  };
}

function computeConfusionMatrix(results: ScenarioResult[]): ConfusionMatrix {
  return {
    truePositives: results.filter((r) => r.validation.result === 'TRUE_POSITIVE').length,
    falsePositives: results.filter((r) => r.validation.result === 'FALSE_POSITIVE').length,
    falseNegatives: results.filter((r) => r.validation.result === 'FALSE_NEGATIVE').length,
    trueNegatives: results.filter((r) => r.validation.result === 'TRUE_NEGATIVE').length,
  };
}

function computeQualityMetrics(cm: ConfusionMatrix): QualityMetrics {
  const precision = safeDivide(cm.truePositives, cm.truePositives + cm.falsePositives);
  const recall = safeDivide(cm.truePositives, cm.truePositives + cm.falseNegatives);
  const f1Score = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const falsePositiveRate = safeDivide(cm.falsePositives, cm.falsePositives + cm.trueNegatives);
  return { precision, recall, f1Score, falsePositiveRate };
}

function countByResult(results: ScenarioResult[], result: ValidationResult): number {
  return results.filter((r) => r.validation.result === result).length;
}

function computeWarningTimeBuckets(results: ScenarioResult[]): Record<string, number> {
  const times = results
    .filter((r) => r.validation.result === 'TRUE_POSITIVE' && r.validation.warningTimeMinutes !== null)
    .map((r) => r.validation.warningTimeMinutes as number);

  const edges = validationConfig.warningTimeBucketsMinutes;
  const labels = [`< ${edges[0]} min`, `${edges[0]}-${edges[1]} min`, `${edges[1]}-${edges[2]} min`, `${edges[2]}-${edges[3]} min`, `${edges[3]}-${edges[4]} min`, `> ${edges[4]} min`];
  const buckets: Record<string, number> = Object.fromEntries(labels.map((l) => [l, 0]));

  for (const t of times) {
    if (t < edges[0]) buckets[labels[0] as string]!++;
    else if (t < edges[1]) buckets[labels[1] as string]!++;
    else if (t < edges[2]) buckets[labels[2] as string]!++;
    else if (t < edges[3]) buckets[labels[3] as string]!++;
    else if (t < edges[4]) buckets[labels[4] as string]!++;
    else buckets[labels[5] as string]!++;
  }
  return buckets;
}

function computeOperationalUsefulness(results: ScenarioResult[]): OperationalUsefulness {
  const tp = results.filter((r) => r.validation.result === 'TRUE_POSITIVE' && r.validation.warningTimeMinutes !== null);
  if (tp.length === 0) return { pctOver30Min: null, pctOver60Min: null, pctUnder5Min: null };
  const over30 = tp.filter((r) => (r.validation.warningTimeMinutes as number) >= 30).length;
  const over60 = tp.filter((r) => (r.validation.warningTimeMinutes as number) >= 60).length;
  const under5 = tp.filter((r) => (r.validation.warningTimeMinutes as number) < 5).length;
  return { pctOver30Min: over30 / tp.length, pctOver60Min: over60 / tp.length, pctUnder5Min: under5 / tp.length };
}

function computeByPredictionType(results: ScenarioResult[]): Record<PredictionType, PredictionTypeMetrics> {
  const types = Object.values(PredictionType);
  const out = {} as Record<PredictionType, PredictionTypeMetrics>;
  for (const type of types) {
    const subset = results.filter((r) => r.predictionType === type);
    const cm = computeConfusionMatrix(subset);
    out[type] = {
      predictionType: type,
      totalPredictions: subset.filter((r) => r.prediction !== null).length,
      notMeasurable: countByResult(subset, 'NOT_MEASURABLE'),
      confirmedBeforePrediction: countByResult(subset, 'CONFIRMED_BEFORE_PREDICTION'),
      pending: countByResult(subset, 'PENDING'),
      warningTime: computeWarningTimeStats(subset),
      ...cm,
      ...computeQualityMetrics(cm),
    };
  }
  return out;
}

/** This is a controlled functional validation over a handful of deterministic scenarios —
 *  NOT a statistically representative production evaluation (Section 31). Always surfaced,
 *  never omitted, regardless of how good the numbers look. */
const SAMPLE_SIZE_DISCLAIMER =
  'This is a controlled functional validation of the prediction engine using a small set of deterministic scenarios, ' +
  'not a statistically representative production evaluation. Precision/recall here describe behavior on these specific ' +
  'controlled cases, not real-world accuracy across the operational dataset. A future phase needs hundreds/thousands of ' +
  'real historical operational events, replayed the same way, before these numbers can be treated as production accuracy.';

function buildInterpretation(summary: ValidationSummary, scenarioCount: number): ValidationReport['interpretation'] {
  const { usefulPrecisionMin, usefulRecallMin, usefulAvgWarningMinutesMin, minSampleSizeForConfidence } = validationConfig.interpretation;

  const accuracy =
    summary.precision === null
      ? 'N/A — no predictions were made across these scenarios, so precision cannot be computed.'
      : `Precision ${(summary.precision * 100).toFixed(1)}%, recall ${summary.recall !== null ? (summary.recall * 100).toFixed(1) + '%' : 'N/A'} ` +
        `on ${summary.truePositives + summary.falsePositives} predictions made and ${summary.truePositives + summary.falseNegatives} actual exceptions observed.`;

  const earlyWarningQuality =
    summary.warningTime.averageMinutes === null
      ? 'N/A — no TRUE_POSITIVE predictions occurred, so no warning-time data exists.'
      : summary.warningTime.averageMinutes >= usefulAvgWarningMinutesMin
        ? `Average warning time of ${summary.warningTime.averageMinutes.toFixed(1)} minutes is above the ${usefulAvgWarningMinutesMin}-minute usefulness threshold — early enough for an operator to plausibly act.`
        : `Average warning time of ${summary.warningTime.averageMinutes.toFixed(1)} minutes is below the ${usefulAvgWarningMinutesMin}-minute usefulness threshold — likely too short for reliable intervention.`;

  const coverage = `${summary.truePositives} of ${summary.truePositives + summary.falseNegatives} actual exceptions were predicted in advance (${summary.falseNegatives} missed entirely).`;

  const dataLimitations =
    summary.notMeasurable > 0
      ? `${summary.notMeasurable} evaluation(s) could not be scored at all due to insufficient source data.`
      : 'No insufficient-data cases were encountered in this scenario set.';

  const meetsUsefulnessBar =
    summary.precision !== null && summary.recall !== null && summary.precision >= usefulPrecisionMin && summary.recall >= usefulRecallMin && (summary.warningTime.averageMinutes ?? 0) >= usefulAvgWarningMinutesMin;

  const verdict = meetsUsefulnessBar
    ? 'On these controlled scenarios, the prediction engine demonstrates useful early-warning capability.'
    : 'On these controlled scenarios, the prediction engine does not consistently meet the configured usefulness bar (precision/recall/warning-time) — see byPredictionType for where it is weakest.';

  const sampleSizeWarning =
    scenarioCount < minSampleSizeForConfidence
      ? `INSUFFICIENT_SAMPLE_SIZE — only ${scenarioCount} scenario result(s) were evaluated. ${verdict} This must not be read as production-grade accuracy.`
      : verdict;

  return { accuracy, earlyWarningQuality, coverage, dataLimitations, sampleSizeWarning };
}

export function buildValidationReport(scenarioResults: ScenarioResult[]): ValidationReport {
  const cm = computeConfusionMatrix(scenarioResults);
  const summary: ValidationSummary = {
    totalScenarioResults: scenarioResults.length,
    totalPredictions: scenarioResults.filter((r) => r.prediction !== null).length,
    notMeasurable: countByResult(scenarioResults, 'NOT_MEASURABLE'),
    confirmedBeforePrediction: countByResult(scenarioResults, 'CONFIRMED_BEFORE_PREDICTION'),
    pending: countByResult(scenarioResults, 'PENDING'),
    warningTime: computeWarningTimeStats(scenarioResults),
    operationalUsefulness: computeOperationalUsefulness(scenarioResults),
    warningTimeBuckets: computeWarningTimeBuckets(scenarioResults),
    ...cm,
    ...computeQualityMetrics(cm),
  };

  return {
    generatedAt: new Date(),
    sampleSizeDisclaimer: SAMPLE_SIZE_DISCLAIMER,
    summary,
    byPredictionType: computeByPredictionType(scenarioResults),
    scenarioResults,
    interpretation: buildInterpretation(summary, scenarioResults.length),
  };
}
