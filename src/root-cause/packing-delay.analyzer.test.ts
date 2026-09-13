import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalOrder, CanonicalPickingTask } from '../canonical/types';
import { PackingDelayEvidence, PersistedException } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));
vi.mock('../adapters', () => ({
  logisticsDataSource: { getOrders: vi.fn(), getPickingTasks: vi.fn(), getPacking: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { PackingDelayAnalyzer } from './packing-delay.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);
const getOrders = vi.mocked(logisticsDataSource.getOrders);
const getPickingTasks = vi.mocked(logisticsDataSource.getPickingTasks);
const getPacking = vi.mocked(logisticsDataSource.getPacking);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-packing-delay-1',
    type: ExceptionType.PACKING_DELAY,
    entityType: EntityType.ORDER,
    entityId: 'ORD-2',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Packing delay for order ORD-2',
    description: null,
    evidence: null,
    detectedAt: new Date('2026-08-20T10:00:00.000Z'),
    resolvedAt: null,
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    updatedAt: new Date('2026-08-20T10:00:00.000Z'),
    ...overrides,
  };
}

function buildSibling(overrides: Partial<PersistedException> & { type: ExceptionType }): PersistedException {
  return buildException({ id: 2, exceptionId: `EXC-${overrides.type.toLowerCase()}-1`, ...overrides });
}

function buildEvidence(overrides: Partial<PackingDelayEvidence> = {}): PackingDelayEvidence {
  return {
    order: { orderId: 'ORD-2', customerId: 'CUST-2', priority: 'NORMAL', expectedDispatch: new Date(), status: 'PACKING' },
    lastPickingCompletedAt: new Date('2026-08-20T09:00:00.000Z'),
    minutesWaiting: 90,
    items: [{ sku: 'SKU-1', productName: 'Widget', orderedQuantity: 5, pickedQuantity: 5, packedQuantity: 0 }],
    ...overrides,
  };
}

/** A COMPLETED-picking, not-yet-packed order finished `minutesAgo` — feeds findOrdersAwaitingPackingTooLong. */
function buildOverdueOrder(orderId: string, minutesAgo: number): { order: CanonicalOrder; task: CanonicalPickingTask } {
  const endTime = new Date(Date.now() - minutesAgo * 60_000);
  return {
    order: {
      orderId,
      customerId: 'CUST-X',
      priority: null,
      orderTime: new Date(endTime.getTime() - 2 * 60 * 60 * 1000),
      expectedDispatchTime: new Date(),
      status: 'PICKING',
      items: [],
    },
    task: {
      taskId: `TASK-${orderId}`,
      orderId,
      pickerId: 'PICKER-X',
      locationId: null,
      startTime: new Date(endTime.getTime() - 60 * 60 * 1000),
      endTime,
      errors: 0,
      distanceWalked: null,
      status: 'COMPLETED',
      items: [],
    },
  };
}

describe('PackingDelayAnalyzer', () => {
  const analyzer = new PackingDelayAnalyzer();

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
    getOrders.mockReset();
    getOrders.mockResolvedValue([]);
    getPickingTasks.mockReset();
    getPickingTasks.mockResolvedValue([]);
    getPacking.mockReset();
    getPacking.mockResolvedValue([]);
  });

  it('1. identifies picking delay as a cause when correlated by orderId', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_DELAY
        ? [buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-2' } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.PICKING_DELAY);
    expect(result.primaryCause?.category).toBe('OBSERVED');
    expect(result.causalChain).toEqual([
      { from: ExceptionType.PICKING_DELAY, to: ExceptionType.PACKING_DELAY, relationship: expect.any(String) },
    ]);
  });

  it('2. identifies packing workload/queue backlog when many other orders are also stuck', async () => {
    const overdue = Array.from({ length: 16 }, (_, i) => buildOverdueOrder(`ORD-${100 + i}`, 90));
    getOrders.mockResolvedValue(overdue.map((o) => o.order));
    getPickingTasks.mockResolvedValue(overdue.map((o) => o.task));
    getPacking.mockResolvedValue([]);

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('PACKING_QUEUE_BACKLOG');
    expect(result.primaryCause?.category).toBe('INFERRED');
  });

  it('3. does not fabricate PACKING_ERROR or DAMAGED_PACKAGE — no packing record exists yet for this order', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('PACKING_ERROR');
    expect(allTypes).not.toContain('DAMAGED_PACKAGE');
  });

  it('4. identifies order complexity for a large order', async () => {
    const evidence = buildEvidence({
      items: Array.from({ length: 10 }, (_, i) => ({
        sku: `SKU-${i}`,
        productName: 'X',
        orderedQuantity: 1,
        pickedQuantity: 1,
        packedQuantity: 0,
      })),
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('ORDER_COMPLEXITY');
    expect(result.primaryCause?.category).toBe('INFERRED');
  });

  it('5. surfaces multiple contributing causes when several signals are present', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_DELAY
        ? [buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-2' } })]
        : [],
    );
    const evidence = buildEvidence({
      items: Array.from({ length: 10 }, (_, i) => ({
        sku: `SKU-${i}`,
        productName: 'X',
        orderedQuantity: 1,
        pickedQuantity: 1,
        packedQuantity: 0,
      })),
    });

    const result = await analyzer.analyze(buildException(), evidence as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toEqual(expect.arrayContaining([ExceptionType.PICKING_DELAY, 'ORDER_COMPLEXITY']));
  });

  it('6. reports INSUFFICIENT_EVIDENCE when nothing correlates', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.limitations.length).toBeGreaterThan(0);
  });
});
