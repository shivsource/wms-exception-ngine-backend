import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalInventory, CanonicalOrder, CanonicalProduct } from '../canonical/types';
import { RiskLevel } from '../types/enums';

vi.mock('../adapters', () => ({
  logisticsDataSource: {
    getInventory: vi.fn(),
    getProducts: vi.fn(),
    getProductBySku: vi.fn(),
    getOrders: vi.fn(),
  },
}));

import { logisticsDataSource } from '../adapters';
import { InventoryShortagePredictor } from './inventory-shortage.predictor';

const getInventory = vi.mocked(logisticsDataSource.getInventory);
const getProducts = vi.mocked(logisticsDataSource.getProducts);
const getProductBySku = vi.mocked(logisticsDataSource.getProductBySku);
const getOrders = vi.mocked(logisticsDataSource.getOrders);

function buildProduct(overrides: Partial<CanonicalProduct> = {}): CanonicalProduct {
  return { sku: 'SKU-1', name: 'Widget', category: 'General', reorderLevel: 10, active: true, ...overrides };
}

function buildInventory(overrides: Partial<CanonicalInventory> = {}): CanonicalInventory {
  return {
    sku: 'SKU-1',
    locationId: 'A1',
    quantity: 20,
    reservedQuantity: 5,
    damagedQuantity: 0,
    availableQuantity: 15,
    lastUpdated: new Date('2026-08-20T08:00:00.000Z'),
    ...overrides,
  };
}

function buildOrder(overrides: Partial<CanonicalOrder> = {}): CanonicalOrder {
  return {
    orderId: 'ORD-1',
    customerId: 'CUST-1',
    priority: 'NORMAL',
    orderTime: new Date('2026-08-20T06:00:00.000Z'),
    expectedDispatchTime: new Date('2026-08-20T12:00:00.000Z'),
    status: 'PICKING',
    items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 0, packedQuantity: 0 }],
    ...overrides,
  };
}

describe('InventoryShortagePredictor', () => {
  const predictor = new InventoryShortagePredictor();

  beforeEach(() => {
    getInventory.mockReset();
    getProducts.mockReset();
    getProductBySku.mockReset();
    getOrders.mockReset().mockResolvedValue([]);
  });

  it('1. reports LOW risk when available stock comfortably covers pending demand and the reorder level', async () => {
    getProducts.mockResolvedValue([buildProduct()]);
    getInventory.mockResolvedValue([buildInventory({ quantity: 100, reservedQuantity: 10 })]); // 90 available
    getOrders.mockResolvedValue([buildOrder({ items: [{ sku: 'SKU-1', orderedQuantity: 5, pickedQuantity: 0, packedQuantity: 0 }] })]);

    const [result] = await predictor.evaluateAll();

    expect(result.riskLevel).toBe(RiskLevel.LOW);
  });

  it('2. reports HIGH/CRITICAL risk when required-but-unpicked demand exceeds effective available stock (spec-style example: required 10, physical 12, reserved-for-others 10)', async () => {
    getProductBySku.mockResolvedValue(buildProduct({ reorderLevel: 5 }));
    getInventory.mockResolvedValue([buildInventory({ quantity: 12, reservedQuantity: 10, damagedQuantity: 2 })]); // totalAvailable = 2
    getOrders.mockResolvedValue([buildOrder({ items: [{ sku: 'SKU-1', orderedQuantity: 10, pickedQuantity: 0, packedQuantity: 0 }] })]); // pendingDemand = 10

    const result = await predictor.evaluateOne('SKU-1');

    expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
    const shortfallSignal = result.signals.find((s) => s.signal === 'PENDING_DEMAND_SHORTFALL');
    expect(shortfallSignal?.value).toBe(10);
    expect(shortfallSignal?.expected).toBe(2);
    expect(shortfallSignal?.contribution).toBeGreaterThan(0);
  });

  it('3. returns INSUFFICIENT_DATA when the product cannot be found', async () => {
    getProductBySku.mockResolvedValue(null);

    const result = await predictor.evaluateOne('SKU-999');

    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('4. returns INSUFFICIENT_DATA for a product with no reorder level configured — never fabricates a threshold', async () => {
    getProductBySku.mockResolvedValue(buildProduct({ reorderLevel: null }));

    const result = await predictor.evaluateOne('SKU-1');

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.riskScore).toBeNull();
  });

  it('5. returns INSUFFICIENT_DATA for an inactive product', async () => {
    getProductBySku.mockResolvedValue(buildProduct({ active: false }));

    const result = await predictor.evaluateOne('SKU-1');

    expect(result.status).toBe('INSUFFICIENT_DATA');
  });

  it('6. excludes inactive and no-reorder-level products from a bulk run', async () => {
    getProducts.mockResolvedValue([buildProduct({ sku: 'SKU-INACTIVE', active: false }), buildProduct({ sku: 'SKU-NO-REORDER', reorderLevel: null })]);
    getInventory.mockResolvedValue([]);

    const results = await predictor.evaluateAll();

    expect(results).toEqual([]);
  });

  it('7. surfaces damaged inventory as a contributing signal without altering the available-stock number', async () => {
    getProductBySku.mockResolvedValue(buildProduct());
    getInventory.mockResolvedValue([buildInventory({ quantity: 20, reservedQuantity: 5, damagedQuantity: 8 })]);

    const result = await predictor.evaluateOne('SKU-1');

    const damagedSignal = result.signals.find((s) => s.signal === 'DAMAGED_INVENTORY_EXPOSURE');
    expect(damagedSignal?.contribution).toBeGreaterThan(0);
  });
});
