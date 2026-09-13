import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalPickingTask, CanonicalPickingTaskItem } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getPickingTasks: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { PickingErrorRule } from './picking-error.rule';

const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);

function item(errorReason: string | null): CanonicalPickingTaskItem {
  return { sku: 'SKU-1', locationId: 'A1', requestedQuantity: 5, pickedQuantity: 3, errorReason };
}

function task(items: CanonicalPickingTaskItem[]): CanonicalPickingTask {
  return {
    taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
    startTime: new Date('2026-09-13T08:00:00.000Z'), endTime: new Date('2026-09-13T08:30:00.000Z'),
    errors: items.filter((i) => i.errorReason !== null).length, distanceWalked: 100, status: 'COMPLETED', items,
  };
}

describe('PickingErrorRule — threshold boundary (findPickingErrorGroups: any item with errorReason !== null; count then classified into severity {medium:1,high:3,critical:5})', () => {
  const rule = new PickingErrorRule();
  beforeEach(() => getPickingTasks.mockReset());

  it('NORMAL: zero items have an error reason — no exception', async () => {
    getPickingTasks.mockResolvedValue([task([item(null), item(null)])]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: exactly 1 error item — the minimum possible detectable count, flagged at MEDIUM', async () => {
    getPickingTasks.mockResolvedValue([task([item(null), item('SHORT_PICK')])]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
    expect(detected[0].evidence.errorCount).toBe(1);
  });

  it('EXCEPTION: 3 error items — severity escalates to HIGH', async () => {
    getPickingTasks.mockResolvedValue([task([item('SHORT_PICK'), item('WRONG_ITEM'), item('DAMAGED'), item(null)])]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.HIGH);
    expect(detected[0].evidence.errorCount).toBe(3);
  });
});
