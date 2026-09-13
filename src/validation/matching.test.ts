import { describe, expect, it } from 'vitest';
import { EntityType, ExceptionType, PredictionType, RiskLevel } from '../types/enums';
import { classifyWarningQuality, evaluatePrediction, isMeaningfulRiskLevel } from './matching';
import { ExceptionSnapshot, PredictionSnapshot } from './types';

const T = (m: number) => new Date(2026, 0, 1, 9, 0, 0, 0).getTime() + m * 60_000;

function prediction(overrides: Partial<PredictionSnapshot> = {}): PredictionSnapshot {
  return {
    predictionId: 'PRED-1',
    predictionType: PredictionType.SLA_BREACH_RISK,
    entityType: EntityType.ORDER,
    entityId: 'ORD-1',
    predictedAt: new Date(T(0)),
    riskScore: 70,
    riskLevel: RiskLevel.HIGH,
    highestRiskScore: 70,
    confidence: 'HIGH',
    predictionWindow: null,
    signals: [],
    explanation: '',
    finalStatus: 'ACTIVE',
    confirmedExceptionId: null,
    observationCount: 1,
    ...overrides,
  };
}

function exception(minutesFromT0: number, overrides: Partial<ExceptionSnapshot> = {}): ExceptionSnapshot {
  return {
    exceptionId: 'EXC-1',
    type: ExceptionType.SLA_AT_RISK,
    entityType: EntityType.ORDER,
    entityId: 'ORD-1',
    detectedAt: new Date(T(minutesFromT0)),
    ...overrides,
  };
}

describe('evaluatePrediction (pure matching logic)', () => {
  it('no prediction, no exception -> TRUE_NEGATIVE', () => {
    const outcome = evaluatePrediction({ prediction: null, candidateExceptions: [], simulationEndTime: new Date(T(60)) });
    expect(outcome.result).toBe('TRUE_NEGATIVE');
    expect(outcome.warningTimeMinutes).toBeNull();
  });

  it('exception with no preceding prediction -> FALSE_NEGATIVE', () => {
    const outcome = evaluatePrediction({ prediction: null, candidateExceptions: [exception(30)], simulationEndTime: new Date(T(60)) });
    expect(outcome.result).toBe('FALSE_NEGATIVE');
    expect(outcome.matchedException?.detectedAt.getTime()).toBe(T(30));
  });

  it('prediction before exception, no window -> TRUE_POSITIVE with exact warning time', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(0)) }),
      candidateExceptions: [exception(40)],
      simulationEndTime: new Date(T(60)),
    });
    expect(outcome.result).toBe('TRUE_POSITIVE');
    expect(outcome.warningTimeMinutes).toBe(40);
  });

  it('sub-minute warning time is preserved, never rounded away', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(0)) }),
      candidateExceptions: [exception(0.5)],
      simulationEndTime: new Date(T(1)),
    });
    expect(outcome.result).toBe('TRUE_POSITIVE');
    expect(outcome.warningTimeMinutes).toBeCloseTo(0.5, 10);
  });

  it('exception at or before the prediction is never a TRUE_POSITIVE -> CONFIRMED_BEFORE_PREDICTION', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(30)) }),
      candidateExceptions: [exception(10)],
      simulationEndTime: new Date(T(60)),
    });
    expect(outcome.result).toBe('CONFIRMED_BEFORE_PREDICTION');
    expect(outcome.result).not.toBe('TRUE_POSITIVE');
  });

  it('exception exactly at the prediction timestamp does not count as a future match', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(30)) }),
      candidateExceptions: [exception(30)],
      simulationEndTime: new Date(T(60)),
    });
    expect(outcome.result).toBe('CONFIRMED_BEFORE_PREDICTION');
  });

  it('exception outside the prediction window -> FALSE_POSITIVE, not TRUE_POSITIVE', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(0)), predictionWindow: { value: 20, unit: 'MINUTES' }, finalStatus: 'RESOLVED' }),
      candidateExceptions: [exception(50)],
      simulationEndTime: new Date(T(60)),
    });
    expect(outcome.result).toBe('FALSE_POSITIVE');
  });

  it('exception within the prediction window -> TRUE_POSITIVE', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(0)), predictionWindow: { value: 60, unit: 'MINUTES' } }),
      candidateExceptions: [exception(50)],
      simulationEndTime: new Date(T(60)),
    });
    expect(outcome.result).toBe('TRUE_POSITIVE');
    expect(outcome.warningTimeMinutes).toBe(50);
  });

  it('prediction made, window still open, no exception yet -> PENDING', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(0)), predictionWindow: { value: 120, unit: 'MINUTES' }, finalStatus: 'ACTIVE' }),
      candidateExceptions: [],
      simulationEndTime: new Date(T(30)),
    });
    expect(outcome.result).toBe('PENDING');
  });

  it('prediction made, window elapsed, no exception -> FALSE_POSITIVE, never PENDING forever', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(0)), predictionWindow: { value: 30, unit: 'MINUTES' }, finalStatus: 'RESOLVED' }),
      candidateExceptions: [],
      simulationEndTime: new Date(T(60)),
    });
    expect(outcome.result).toBe('FALSE_POSITIVE');
  });

  it('picks the earliest valid future exception when several exist', () => {
    const outcome = evaluatePrediction({
      prediction: prediction({ predictedAt: new Date(T(0)) }),
      candidateExceptions: [exception(50, { exceptionId: 'EXC-LATE' }), exception(20, { exceptionId: 'EXC-EARLY' })],
      simulationEndTime: new Date(T(60)),
    });
    expect(outcome.result).toBe('TRUE_POSITIVE');
    expect(outcome.matchedException?.exceptionId).toBe('EXC-EARLY');
    expect(outcome.warningTimeMinutes).toBe(20);
  });
});

describe('classifyWarningQuality', () => {
  it.each([
    [null, 'NOT_APPLICABLE'],
    [2, 'TOO_LATE'],
    [4.99, 'TOO_LATE'],
    [5, 'LIMITED'],
    [29.9, 'LIMITED'],
    [30, 'GOOD'],
    [59.9, 'GOOD'],
    [60, 'EXCELLENT'],
    [200, 'EXCELLENT'],
  ] as const)('%s minutes -> %s', (minutes, expected) => {
    expect(classifyWarningQuality(minutes)).toBe(expected);
  });
});

describe('isMeaningfulRiskLevel', () => {
  it('LOW and UNKNOWN are not meaningful; MEDIUM/HIGH/CRITICAL are', () => {
    expect(isMeaningfulRiskLevel(RiskLevel.LOW)).toBe(false);
    expect(isMeaningfulRiskLevel(RiskLevel.UNKNOWN)).toBe(false);
    expect(isMeaningfulRiskLevel(RiskLevel.MEDIUM)).toBe(true);
    expect(isMeaningfulRiskLevel(RiskLevel.HIGH)).toBe(true);
    expect(isMeaningfulRiskLevel(RiskLevel.CRITICAL)).toBe(true);
  });
});
