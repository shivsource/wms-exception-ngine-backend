import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalInventory, CanonicalProduct } from '../canonical/types';
import { ExceptionSeverity } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: { getInventory: vi.fn(), getProducts: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { InventoryShortageRule } from './inventory-shortage.rule';

const getInventory = vi.mocked(logisticsDataSource.getInventory);
const getProducts = vi.mocked(logisticsDataSource.getProducts);

const product = (overrides: Partial<CanonicalProduct> = {}): CanonicalProduct => ({
  sku: 'SKU-1', name: 'Widget', category: null, reorderLevel: 20, active: true, ...overrides,
});
const inventory = (quantity: number, overrides: Partial<CanonicalInventory> = {}): CanonicalInventory => ({
  sku: 'SKU-1', locationId: 'A1', quantity, reservedQuantity: 0, damagedQuantity: 0,
  availableQuantity: quantity, lastUpdated: new Date('2026-09-13T09:00:00.000Z'), ...overrides,
});

describe('InventoryShortageRule — threshold boundary (findInventoryShortages: totalAvailable < reorderLevel, strict)', () => {
  const rule = new InventoryShortageRule();

  beforeEach(() => {
    getProducts.mockReset().mockResolvedValue([product({ reorderLevel: 20 })]);
    getInventory.mockReset();
  });

  it('NORMAL: available (25) comfortably above reorder level (20) — no exception', async () => {
    getInventory.mockResolvedValue([inventory(25)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('BOUNDARY: available (20) exactly equal to reorder level (20) — NOT flagged (rule uses strict "<", not "<=")', async () => {
    getInventory.mockResolvedValue([inventory(20)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('EXCEPTION: available (15) below reorder level (20) by 5 units — flagged at MEDIUM (shortfallRatio 0.25)', async () => {
    getInventory.mockResolvedValue([inventory(15)]);
    const detected = await rule.evaluate();
    expect(detected).toHaveLength(1);
    expect(detected[0].severity).toBe(ExceptionSeverity.MEDIUM);
    expect(detected[0].evidence.shortfallUnits).toBe(5);
  });

  it('a product with no reorderLevel set can never be flagged, no matter how low available stock is (documented NULL semantics)', async () => {
    getProducts.mockResolvedValue([product({ reorderLevel: null })]);
    getInventory.mockResolvedValue([inventory(0)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });

  it('an inactive product is never flagged even when available stock is below its reorder level', async () => {
    getProducts.mockResolvedValue([product({ active: false, reorderLevel: 20 })]);
    getInventory.mockResolvedValue([inventory(0)]);
    expect(await rule.evaluate()).toHaveLength(0);
  });
});
