import { describe, expect, it } from 'vitest';
import { EntityType, PredictionType, RiskLevel } from '../types/enums';
import { activeResult, capScore, classifyRiskLevel, insufficientData, overageRatio, scoreFromSignals, urgencyRatio } from './shared';

describe('capScore', () => {
  it('1. clamps above 100 down to 100', () => {
    expect(capScore(150)).toBe(100);
  });

  it('2. clamps below 0 up to 0', () => {
    expect(capScore(-10)).toBe(0);
  });

  it('3. rounds fractional scores', () => {
    expect(capScore(42.6)).toBe(43);
  });
});

describe('classifyRiskLevel', () => {
  it('4. classifies boundary values into the correct band (0-29 LOW, 30-59 MEDIUM, 60-79 HIGH, 80-100 CRITICAL)', () => {
    expect(classifyRiskLevel(0)).toBe(RiskLevel.LOW);
    expect(classifyRiskLevel(29)).toBe(RiskLevel.LOW);
    expect(classifyRiskLevel(30)).toBe(RiskLevel.MEDIUM);
    expect(classifyRiskLevel(59)).toBe(RiskLevel.MEDIUM);
    expect(classifyRiskLevel(60)).toBe(RiskLevel.HIGH);
    expect(classifyRiskLevel(79)).toBe(RiskLevel.HIGH);
    expect(classifyRiskLevel(80)).toBe(RiskLevel.CRITICAL);
    expect(classifyRiskLevel(100)).toBe(RiskLevel.CRITICAL);
  });
});

describe('urgencyRatio', () => {
  it('5. is 0 at the start of the window and 1 at the deadline', () => {
    expect(urgencyRatio(120, 120)).toBe(0);
    expect(urgencyRatio(0, 120)).toBe(1);
  });

  it('6. never exceeds 1 once past the deadline', () => {
    expect(urgencyRatio(-60, 120)).toBe(1);
  });
});

describe('overageRatio', () => {
  it('7. is 0 when actual is at or below expected', () => {
    expect(overageRatio(20, 30)).toBe(0);
    expect(overageRatio(30, 30)).toBe(0);
  });

  it('8. saturates at 1 once actual reaches the saturation multiple of expected', () => {
    expect(overageRatio(60, 30, 2)).toBe(1);
    expect(overageRatio(90, 30, 2)).toBe(1);
  });

  it('9. scales linearly between expected and the saturation point', () => {
    expect(overageRatio(45, 30, 2)).toBeCloseTo(0.5);
  });
});

describe('scoreFromSignals / activeResult', () => {
  it('10. sums signal contributions and caps at 100', () => {
    const score = scoreFromSignals([
      { signal: 'A', value: 1, contribution: 60, reason: 'a' },
      { signal: 'B', value: 2, contribution: 60, reason: 'b' },
    ]);
    expect(score).toBe(100);
  });

  it('11. activeResult classifies riskLevel from the summed score', () => {
    const result = activeResult({
      predictionType: PredictionType.SLA_BREACH_RISK,
      entityType: EntityType.ORDER,
      entityId: 'ORD-1',
      signals: [{ signal: 'A', value: 1, contribution: 85, reason: 'a' }],
      confidence: 'HIGH',
      predictionWindow: { value: 10, unit: 'MINUTES' },
      explanation: 'test',
    });
    expect(result.riskScore).toBe(85);
    expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
    expect(result.status).toBe('ACTIVE');
  });
});

describe('insufficientData', () => {
  it('12. never fabricates a risk score — riskScore is null and riskLevel is UNKNOWN', () => {
    const result = insufficientData(PredictionType.PICKING_DELAY_RISK, EntityType.PICKING_TASK, 'TASK-1', ['not found']);
    expect(result.riskScore).toBeNull();
    expect(result.riskLevel).toBe(RiskLevel.UNKNOWN);
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.signals).toEqual([]);
  });
});
