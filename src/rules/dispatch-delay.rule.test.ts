import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalPacking } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getPacking: vi.fn(), getDispatch: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { DispatchDelayRule } from './dispatch-delay.rule';

const getPacking = vi.mocked(logisticsDataSource.getPacking);
const getDispatch = vi.mocked(logisticsDataSource.getDispatch);
const now = new Date('2026-09-13T09:00:00.000Z');

function packed(minutesAgo: number): CanonicalPacking {
  return { orderId: 'ORD-1', packingTime: new Date(now.getTime() - minutesAgo * 60_000), packageSize: 'M', weight: 2, damaged: false, packedBy: 'PACKER-1' };
}

describe('DispatchDelayRule — threshold boundary (findOrdersAwaitingDispatchTooLong: minutesWaiting > thresholdMinutes(60), strict)', () => {
  const rule = new DispatchDelayRule();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    getDispatch.mockReset().mockResolvedValue([]); // never departed
    getPacking.mockReset();
  });

  it('NORMAL: packed 59min ago, under the 60min threshold — no exception', async () => {
    getPacking.mockResolvedValue([packed(59)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: packed exactly 60min ago — NOT flagged (rule uses strict ">", not ">=")', async () => {
    getPacking.mockResolvedValue([packed(60)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('EXCEPTION: packed 61min ago — flagged at MEDIUM', async () => {
    getPacking.mockResolvedValue([packed(61)]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
    expect(detected[0].evidence.minutesWaiting).toBe(61);
  });

  it('an order that has already departed is never flagged, however long ago it was packed', async () => {
    getPacking.mockResolvedValue([packed(500)]);
    getDispatch.mockResolvedValue([{ orderId: 'ORD-1', truckId: 'TRUCK-1', carrier: 'CARRIER-1', dock: 'D1', loadingTime: now, departureTime: now }]);
    expect(await rule.evaluate()).toHaveLength(0);
  });
});
