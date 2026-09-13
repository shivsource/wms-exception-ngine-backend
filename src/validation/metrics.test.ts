import { describe, expect, it } from 'vitest';
import { EntityType, PredictionType } from '../types/enums';
import { buildValidationReport, computeWarningTimeStats } from './metrics';
import { ScenarioResult, ValidationResult } from './types';

function result(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: 'SX',
    scenarioName: 'Test',
    targetIndex: 0,
    predictionType: PredictionType.SLA_BREACH_RISK,
    entityType: EntityType.ORDER,
    entityId: 'ORD-X',
    prediction: null,
    actualOutcome: { exceptionOccurred: false, exceptionType: null, exceptionTimestamp: null, exceptionId: null },
    validation: { result: 'TRUE_NEGATIVE', warningTimeMinutes: null, warningQuality: 'NOT_APPLICABLE' },
    expectedResult: 'TRUE_NEGATIVE',
    passed: true,
    idempotencyPassed: null,
    ...overrides,
  };
}

function withResult(r: ValidationResult, warningTimeMinutes: number | null = null): ScenarioResult {
  return result({ validation: { result: r, warningTimeMinutes, warningQuality: 'NOT_APPLICABLE' } });
}

describe('buildValidationReport — division-by-zero safety', () => {
  it('no scenario results at all -> every ratio is null, never NaN', () => {
    const report = buildValidationReport([]);
    expect(report.summary.precision).toBeNull();
    expect(report.summary.recall).toBeNull();
    expect(report.summary.f1Score).toBeNull();
    expect(report.summary.falsePositiveRate).toBeNull();
    expect(report.summary.warningTime.averageMinutes).toBeNull();
  });

  it('only TRUE_NEGATIVEs -> precision/recall null (no positives predicted or observed), FPR is 0 not null', () => {
    const report = buildValidationReport([withResult('TRUE_NEGATIVE'), withResult('TRUE_NEGATIVE')]);
    expect(report.summary.precision).toBeNull();
    expect(report.summary.recall).toBeNull();
    expect(report.summary.falsePositiveRate).toBe(0);
  });

  it('only FALSE_POSITIVEs -> precision is 0 (not null, not NaN), recall is null', () => {
    const report = buildValidationReport([withResult('FALSE_POSITIVE')]);
    expect(report.summary.precision).toBe(0);
    expect(report.summary.recall).toBeNull();
  });
});

describe('buildValidationReport — confusion matrix and quality metrics', () => {
  it('computes precision/recall/F1 correctly on a known mix', () => {
    const results = [withResult('TRUE_POSITIVE', 10), withResult('TRUE_POSITIVE', 20), withResult('FALSE_POSITIVE'), withResult('FALSE_NEGATIVE'), withResult('TRUE_NEGATIVE')];
    const report = buildValidationReport(results);
    expect(report.summary.truePositives).toBe(2);
    expect(report.summary.falsePositives).toBe(1);
    expect(report.summary.falseNegatives).toBe(1);
    expect(report.summary.trueNegatives).toBe(1);
    expect(report.summary.precision).toBeCloseTo(2 / 3, 10);
    expect(report.summary.recall).toBeCloseTo(2 / 3, 10);
    expect(report.summary.f1Score).toBeCloseTo(2 / 3, 10);
  });
});

describe('computeWarningTimeStats', () => {
  it('computes average/median/min/max/percentiles over TRUE_POSITIVE warning times only', () => {
    const results = [withResult('TRUE_POSITIVE', 10), withResult('TRUE_POSITIVE', 20), withResult('TRUE_POSITIVE', 30), withResult('FALSE_POSITIVE'), withResult('TRUE_NEGATIVE')];
    const stats = computeWarningTimeStats(results);
    expect(stats.count).toBe(3);
    expect(stats.averageMinutes).toBeCloseTo(20, 10);
    expect(stats.medianMinutes).toBeCloseTo(20, 10);
    expect(stats.minMinutes).toBe(10);
    expect(stats.maxMinutes).toBe(30);
  });

  it('returns all-null stats when there are no TRUE_POSITIVEs', () => {
    const stats = computeWarningTimeStats([withResult('FALSE_POSITIVE'), withResult('TRUE_NEGATIVE')]);
    expect(stats.count).toBe(0);
    expect(stats.averageMinutes).toBeNull();
    expect(stats.medianMinutes).toBeNull();
  });
});

describe('buildValidationReport — byPredictionType', () => {
  it('reports every known PredictionType, even with zero samples', () => {
    const report = buildValidationReport([]);
    expect(Object.keys(report.byPredictionType).sort()).toEqual(Object.values(PredictionType).sort());
    for (const metrics of Object.values(report.byPredictionType)) {
      expect(metrics.totalPredictions).toBe(0);
      expect(metrics.precision).toBeNull();
    }
  });

  it('splits scenario results by their own predictionType, not mixed together', () => {
    const results = [
      result({ predictionType: PredictionType.SLA_BREACH_RISK, validation: { result: 'TRUE_POSITIVE', warningTimeMinutes: 15, warningQuality: 'LIMITED' } }),
      result({ predictionType: PredictionType.PICKING_DELAY_RISK, validation: { result: 'FALSE_POSITIVE', warningTimeMinutes: null, warningQuality: 'NOT_APPLICABLE' } }),
    ];
    const report = buildValidationReport(results);
    expect(report.byPredictionType[PredictionType.SLA_BREACH_RISK]!.truePositives).toBe(1);
    expect(report.byPredictionType[PredictionType.SLA_BREACH_RISK]!.falsePositives).toBe(0);
    expect(report.byPredictionType[PredictionType.PICKING_DELAY_RISK]!.falsePositives).toBe(1);
    expect(report.byPredictionType[PredictionType.PICKING_DELAY_RISK]!.truePositives).toBe(0);
  });
});

describe('buildValidationReport — sample size disclaimer', () => {
  it('always includes the controlled-validation disclaimer, regardless of how good the numbers are', () => {
    const perfect = [withResult('TRUE_POSITIVE', 90), withResult('TRUE_POSITIVE', 90)];
    const report = buildValidationReport(perfect);
    expect(report.sampleSizeDisclaimer).toMatch(/not a statistically representative production evaluation/i);
    expect(report.interpretation.sampleSizeWarning).toMatch(/INSUFFICIENT_SAMPLE_SIZE/);
  });
});
