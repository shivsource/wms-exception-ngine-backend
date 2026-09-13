import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalOrder, CanonicalReturn } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getReturns: vi.fn(), getOrders: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { HighReturnRateRule } from './high-return-rate.rule';

const getReturns = vi.mocked(logisticsDataSource.getReturns);
const getOrders = vi.mocked(logisticsDataSource.getOrders);
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

function ordersFor(sku: string, count: number): CanonicalOrder[] {
  return Array.from({ length: count }, (_, i) => ({
    orderId: `ORD-${i}`, customerId: 'CUST-1', priority: null, orderTime: daysAgo(5),
    expectedDispatchTime: daysAgo(4), status: 'DISPATCHED' as const,
    items: [{ sku, orderedQuantity: 1, pickedQuantity: 1, packedQuantity: 1 }],
  }));
}
function returnsFor(sku: string, count: number): CanonicalReturn[] {
  return Array.from({ length: count }, (_, i) => ({
    returnId: `RET-${i}`, orderId: `ORD-${i}`, sku, reason: 'WRONG_SIZE', condition: 'GOOD' as const, returnedAt: daysAgo(2),
  }));
}

describe('HighReturnRateRule — two independent gates: sample-size significance (totalOrdered >= 5, inclusive) then rate {medium:0.05, high:0.1, critical:0.2} (inclusive ">=")', () => {
  const rule = new HighReturnRateRule();
  beforeEach(() => {
    getReturns.mockReset();
    getOrders.mockReset();
  });

  it('NORMAL: rate 1% (1 return / 100 ordered), well under the 5% medium threshold — no exception', async () => {
    getOrders.mockResolvedValue(ordersFor('SKU-1', 100));
    getReturns.mockResolvedValue(returnsFor('SKU-1', 1));
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: rate exactly 5% (1 return / 20 ordered) — IS flagged at MEDIUM (rule uses ">=", not strict ">")', async () => {
    getOrders.mockResolvedValue(ordersFor('SKU-2', 20));
    getReturns.mockResolvedValue(returnsFor('SKU-2', 1));
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
    expect(detected[0].evidence.returnRatePercentage).toBeCloseTo(5, 5);
  });

  it('EXCEPTION: rate 20% (4 returns / 20 ordered) — flagged at CRITICAL', async () => {
    getOrders.mockResolvedValue(ordersFor('SKU-3', 20));
    getReturns.mockResolvedValue(returnsFor('SKU-3', 4));
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.CRITICAL);
  });

  it('SAMPLE-SIZE GATE: a 100% return rate (4 returns / 4 ordered) is still suppressed below the minOrderedForSignificance(5) threshold — "a rate cannot be established from too small a sample" (Section 8)', async () => {
    getOrders.mockResolvedValue(ordersFor('SKU-4', 4));
    getReturns.mockResolvedValue(returnsFor('SKU-4', 4));
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('SAMPLE-SIZE BOUNDARY: totalOrdered exactly 5 (the minimum) is included — a return rate of 20% there is flagged', async () => {
    getOrders.mockResolvedValue(ordersFor('SKU-5', 5));
    getReturns.mockResolvedValue(returnsFor('SKU-5', 1));
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.CRITICAL);
  });

  it('a SKU with zero returns is never a candidate at all, regardless of order volume', async () => {
    getOrders.mockResolvedValue(ordersFor('SKU-6', 500));
    getReturns.mockResolvedValue([]);
    expect(await rule.evaluate()).toHaveLength(0);
  });
});
