import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalInventory } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getInventory: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { InventoryDiscrepancyRule } from './inventory-discrepancy.rule';

const getInventory = vi.mocked(logisticsDataSource.getInventory);

const inventory = (overrides: Partial<CanonicalInventory> = {}): CanonicalInventory => ({
  sku: 'SKU-1', locationId: 'A1', quantity: 10, reservedQuantity: 10, damagedQuantity: 0,
  availableQuantity: 0, lastUpdated: new Date('2026-09-13T09:00:00.000Z'), ...overrides,
});

describe('InventoryDiscrepancyRule — threshold boundary (reservedQuantity > quantity || damagedQuantity > quantity, strict)', () => {
  const rule = new InventoryDiscrepancyRule();
  beforeEach(() => getInventory.mockReset());

  it('NORMAL: reserved (8) and damaged (0) both comfortably at or under quantity (10) — no exception', async () => {
    getInventory.mockResolvedValue([inventory({ quantity: 10, reservedQuantity: 8, damagedQuantity: 0 })]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: reserved (10) exactly equal to quantity (10) — NOT flagged (rule uses strict ">", not ">=")', async () => {
    getInventory.mockResolvedValue([inventory({ quantity: 10, reservedQuantity: 10, damagedQuantity: 10 })]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('EXCEPTION: reserved (11) exceeds quantity (10) by 1 unit — flagged at MEDIUM (excess ratio 0.1)', async () => {
    getInventory.mockResolvedValue([inventory({ quantity: 10, reservedQuantity: 11, damagedQuantity: 0 })]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
  });

  it('damagedQuantity exceeding quantity alone (reserved normal) also triggers the rule', async () => {
    getInventory.mockResolvedValue([inventory({ quantity: 10, reservedQuantity: 5, damagedQuantity: 11 })]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].entityId).toBe('SKU-1:A1');
  });
});
