import { describe, expect, it } from 'vitest';
import { deriveOutcomeResult } from './outcome-engine';
import { ActionImpact } from '../interfaces';
import { OutcomeResult } from '../types/enums';

function buildImpact(overrides: Partial<ActionImpact> = {}): ActionImpact {
  return {
    actionId: 'ACT-1',
    metrics: [{ metric: 'PICKING_TIME', before: 90, after: 30, unit: 'MINUTES' }],
    minutesSaved: 60,
    percentageImprovement: 66.67,
    slaRecovered: null,
    ordersAffected: 0,
    tasksAffected: 1,
    severityChange: null,
    notes: [],
    ...overrides,
  };
}

describe('deriveOutcomeResult', () => {
  it('1. FAILED when the simulation itself failed, regardless of impact', () => {
    expect(deriveOutcomeResult(buildImpact({ percentageImprovement: 90 }), false)).toBe(OutcomeResult.FAILED);
  });

  it('2. SUCCESS when improvement is at or above the success band', () => {
    expect(deriveOutcomeResult(buildImpact({ percentageImprovement: 20 }), true)).toBe(OutcomeResult.SUCCESS);
    expect(deriveOutcomeResult(buildImpact({ percentageImprovement: 66.67 }), true)).toBe(OutcomeResult.SUCCESS);
  });

  it('3. PARTIAL_SUCCESS when improvement is positive but below the success band', () => {
    expect(deriveOutcomeResult(buildImpact({ percentageImprovement: 5 }), true)).toBe(OutcomeResult.PARTIAL_SUCCESS);
  });

  it('4. NO_IMPROVEMENT when improvement is zero or negative', () => {
    expect(deriveOutcomeResult(buildImpact({ percentageImprovement: 0 }), true)).toBe(OutcomeResult.NO_IMPROVEMENT);
    expect(deriveOutcomeResult(buildImpact({ percentageImprovement: -5 }), true)).toBe(OutcomeResult.NO_IMPROVEMENT);
  });

  it('5. SUCCESS when percentageImprovement is null but slaRecovered is true', () => {
    expect(deriveOutcomeResult(buildImpact({ percentageImprovement: null, slaRecovered: true }), true)).toBe(OutcomeResult.SUCCESS);
  });

  it('6. SUCCESS when there is no quantitative metric at all (e.g. ESCALATE_OPERATION)', () => {
    expect(
      deriveOutcomeResult(buildImpact({ percentageImprovement: null, slaRecovered: null, metrics: [] }), true),
    ).toBe(OutcomeResult.SUCCESS);
  });

  it('7. NO_IMPROVEMENT when a metric exists but before/after are identical and no percentage could be computed', () => {
    const impact = buildImpact({
      percentageImprovement: null,
      slaRecovered: null,
      metrics: [{ metric: 'INVENTORY_AVAILABILITY', before: 0, after: 0, unit: 'UNITS' }],
    });
    expect(deriveOutcomeResult(impact, true)).toBe(OutcomeResult.NO_IMPROVEMENT);
  });
});
