import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalOrder } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getOrders: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { SlaAtRiskRule } from './sla-at-risk.rule';

const getOrders = vi.mocked(logisticsDataSource.getOrders);
const now = new Date('2026-09-13T09:00:00.000Z');

function order(minutesUntilDispatch: number, status: CanonicalOrder['status'] = 'PICKING'): CanonicalOrder {
  return {
    orderId: 'ORD-1', customerId: 'CUST-1', priority: 'NORMAL', orderTime: new Date(now.getTime() - 30 * 60_000),
    expectedDispatchTime: new Date(now.getTime() + minutesUntilDispatch * 60_000), status, items: [],
  };
}

describe('SlaAtRiskRule — threshold boundary (findOrdersAtRiskOfSlaBreach: expectedDispatchTime <= now+windowMinutes(120), inclusive)', () => {
  const rule = new SlaAtRiskRule();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    getOrders.mockReset();
  });

  it('NORMAL: 121 minutes until dispatch, just outside the 120min window — no exception', async () => {
    getOrders.mockResolvedValue([order(121)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: exactly 120 minutes until dispatch — IS flagged (rule uses "<=", not strict "<"), but at LOW severity (urgencyRatio 0 at the window\'s outer edge)', async () => {
    getOrders.mockResolvedValue([order(120)]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.LOW);
    expect(detected[0].evidence.minutesRemaining).toBe(120);
  });

  it('EXCEPTION: 60 minutes until dispatch, halfway through the window — flagged at MEDIUM (urgencyRatio 0.5)', async () => {
    getOrders.mockResolvedValue([order(60)]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('an already-DISPATCHED order is never flagged, however overdue its expected dispatch time (the rule\'s own filter, independent of the excludeStatus filter passed to getOrders)', async () => {
    getOrders.mockResolvedValue([order(-30, 'DISPATCHED')]); // 30min overdue, but already DISPATCHED
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('an order with a null status is never flagged (an unknown status cannot be proven "not yet dispatched")', async () => {
    getOrders.mockResolvedValue([order(30, null)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });
});
