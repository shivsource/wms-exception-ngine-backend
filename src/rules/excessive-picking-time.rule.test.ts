import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalPickingTask } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getPickingTasks: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { ExcessivePickingTimeRule } from './excessive-picking-time.rule';

const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);
const start = new Date('2026-09-13T08:00:00.000Z');

/** A COMPLETED task whose duration is `minutes` (start fixed, end offset). */
function completed(id: string, minutes: number): CanonicalPickingTask {
  return {
    taskId: id, orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
    startTime: start, endTime: new Date(start.getTime() + minutes * 60_000),
    errors: 0, distanceWalked: 100, status: 'COMPLETED', items: [],
  };
}

/**
 * The average this rule compares against always includes the task being evaluated (no
 * separate "baseline population" — see excessive-picking-time.rule.ts), so ratios must be
 * solved algebraically rather than assumed. With one other task of duration B and a target
 * of duration D, avg = (B+D)/2 and ratio = D/avg = 2D/(B+D). Solving for ratio = threshold T
 * gives D = T*B/(2-T) — used below to land exactly on the 1.5 (medium) boundary.
 */
describe('ExcessivePickingTimeRule — threshold boundary (classifyByRatio vs warehouse average, thresholds {medium:1.5, high:2, critical:3}, inclusive ">=")', () => {
  const rule = new ExcessivePickingTimeRule();
  beforeEach(() => getPickingTasks.mockReset());

  it('NORMAL: two tasks close to each other (ratios ~0.95/1.05) — no exception', async () => {
    getPickingTasks.mockResolvedValue([completed('T-A', 40), completed('T-B', 44)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: ratio exactly 1.5 (20min baseline, 60min target -> avg 40, 60/40=1.5) — IS flagged (rule uses ">=", not strict ">")', async () => {
    getPickingTasks.mockResolvedValue([completed('BASE', 20), completed('T-C', 60)]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].entityId).toBe('T-C');
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
    expect(detected[0].evidence.ratio).toBeCloseTo(1.5, 5);
  });

  it('EXCEPTION: ratio 2.5 (three 20min baseline tasks, one 100min target -> avg 40) — severity escalates to HIGH', async () => {
    getPickingTasks.mockResolvedValue([
      completed('BASE-1', 20), completed('BASE-2', 20), completed('BASE-3', 20), completed('T-D', 100),
    ]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].entityId).toBe('T-D');
    expect(detected[0].severity).toBe(ExceptionSeverity.HIGH);
    expect(detected[0].evidence.ratio).toBeCloseTo(2.5, 5);
  });

  it('a single completed task can never be excessive relative to itself (ratio is always exactly 1.0)', async () => {
    getPickingTasks.mockResolvedValue([completed('T-ONLY', 999)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });
});
