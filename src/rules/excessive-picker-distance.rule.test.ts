import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalPickingTask } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getPickingTasks: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { ExcessivePickerDistanceRule } from './excessive-picker-distance.rule';

const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);

function completed(id: string, distanceWalked: number): CanonicalPickingTask {
  return {
    taskId: id, orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
    startTime: new Date('2026-09-13T08:00:00.000Z'), endTime: new Date('2026-09-13T08:30:00.000Z'),
    errors: 0, distanceWalked, status: 'COMPLETED', items: [],
  };
}

/** Same self-referential-average math as ExcessivePickingTimeRule — see that test file's header. */
describe('ExcessivePickerDistanceRule — threshold boundary (classifyByRatio vs warehouse average distance, thresholds {medium:1.5, high:2, critical:3}, inclusive ">=")', () => {
  const rule = new ExcessivePickerDistanceRule();
  beforeEach(() => getPickingTasks.mockReset());

  it('NORMAL: two tasks close to each other (ratios ~0.95/1.05) — no exception', async () => {
    getPickingTasks.mockResolvedValue([completed('T-A', 400), completed('T-B', 440)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: ratio exactly 1.5 (200m baseline, 600m target -> avg 400, 600/400=1.5) — IS flagged (rule uses ">=", not strict ">")', async () => {
    getPickingTasks.mockResolvedValue([completed('BASE', 200), completed('T-C', 600)]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].entityId).toBe('T-C');
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
    expect(detected[0].evidence.ratio).toBeCloseTo(1.5, 5);
  });

  it('EXCEPTION: ratio 2.5 (three 200m baseline tasks, one 1000m target -> avg 400) — severity escalates to HIGH', async () => {
    getPickingTasks.mockResolvedValue([
      completed('BASE-1', 200), completed('BASE-2', 200), completed('BASE-3', 200), completed('T-D', 1000),
    ]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].entityId).toBe('T-D');
    expect(detected[0].severity).toBe(ExceptionSeverity.HIGH);
    expect(detected[0].evidence.ratio).toBeCloseTo(2.5, 5);
  });
});
