import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalDispatch } from '../canonical/types';
import { DispatchDelayEvidence, PersistedException } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn() },
}));
vi.mock('../adapters', () => ({
  logisticsDataSource: { getDispatch: vi.fn() },
}));

import { logisticsDataSource } from '../adapters';
import { exceptionRepository } from '../repositories';
import { DispatchDelayAnalyzer } from './dispatch-delay.analyzer';

const findAllByType = vi.mocked(exceptionRepository.findAllByType);
const getDispatch = vi.mocked(logisticsDataSource.getDispatch);

function buildException(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1,
    exceptionId: 'EXC-dispatch-delay-1',
    type: ExceptionType.DISPATCH_DELAY,
    entityType: EntityType.ORDER,
    entityId: 'ORD-3',
    severity: ExceptionSeverity.MEDIUM,
    status: ExceptionStatus.OPEN,
    title: 'Dispatch delay for order ORD-3',
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

function buildEvidence(overrides: Partial<DispatchDelayEvidence> = {}): DispatchDelayEvidence {
  return {
    order: { orderId: 'ORD-3', customerId: 'CUST-3', priority: 'NORMAL', expectedDispatch: new Date(), status: 'READY_TO_DISPATCH' },
    packing: { packingTime: new Date('2026-08-20T09:00:00.000Z'), packageSize: 'M', weight: 2.5, damaged: false, packedBy: 'PACKER-1' },
    minutesWaiting: 90,
    ...overrides,
  };
}

function buildDispatch(overrides: Partial<CanonicalDispatch> = {}): CanonicalDispatch {
  return { orderId: 'ORD-3', truckId: 'TRUCK-1', carrier: 'Carrier', dock: 'DOCK-1', loadingTime: null, departureTime: null, ...overrides };
}

describe('DispatchDelayAnalyzer', () => {
  const analyzer = new DispatchDelayAnalyzer();

  // Populated per-test; the mock below routes getDispatch({orderId}) vs. getDispatch({dock}) to these.
  let orderDispatchRecords: CanonicalDispatch[];
  let dockDispatchRecords: CanonicalDispatch[];

  beforeEach(() => {
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);

    orderDispatchRecords = [];
    dockDispatchRecords = [];
    getDispatch.mockReset();
    getDispatch.mockImplementation(async (filter) => {
      if (filter?.orderId) return orderDispatchRecords;
      if (filter?.dock) return dockDispatchRecords;
      return [];
    });
  });

  it('1. identifies packing delay as a cause when correlated by order code', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PACKING_DELAY
        ? [buildSibling({ type: ExceptionType.PACKING_DELAY, entityType: EntityType.ORDER, entityId: 'ORD-3' })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.PACKING_DELAY);
  });

  it('2. identifies picking delay as a cause when correlated by orderId', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PICKING_DELAY
        ? [buildSibling({ type: ExceptionType.PICKING_DELAY, entityType: EntityType.PICKING_TASK, entityId: 'TASK-1', evidence: { orderId: 'ORD-3' } })]
        : [],
    );

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe(ExceptionType.PICKING_DELAY);
  });

  it('3. identifies loading delay when a dispatch record exists but has not departed', async () => {
    orderDispatchRecords = [buildDispatch({ loadingTime: new Date(Date.now() - 10 * 60 * 60 * 1000) })];

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause?.type).toBe('LOADING_DELAY');
    expect(result.primaryCause?.category).toBe('OBSERVED');
  });

  it('4. identifies dock congestion when the same dock has other waiting orders', async () => {
    orderDispatchRecords = [buildDispatch({ loadingTime: new Date(Date.now() - 10 * 60 * 60 * 1000), dock: 'DOCK-1' })];
    dockDispatchRecords = Array.from({ length: 6 }, (_, i) => buildDispatch({ orderId: `ORD-OTHER-${i}`, dock: 'DOCK-1', departureTime: null }));

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toContain('DOCK_CONGESTION');
  });

  it('5. does not fabricate TRUCK_DELAY or CARRIER_DELAY — no schedule/SLA data exists to evaluate them', async () => {
    orderDispatchRecords = [buildDispatch({ loadingTime: new Date() })];

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const allTypes = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(allTypes).not.toContain('TRUCK_DELAY');
    expect(allTypes).not.toContain('CARRIER_DELAY');
  });

  it('6. surfaces multiple contributing causes when several signals are present', async () => {
    findAllByType.mockImplementation(async (type) =>
      type === ExceptionType.PACKING_DELAY
        ? [buildSibling({ type: ExceptionType.PACKING_DELAY, entityType: EntityType.ORDER, entityId: 'ORD-3' })]
        : [],
    );
    orderDispatchRecords = [buildDispatch({ loadingTime: new Date(Date.now() - 10 * 60 * 60 * 1000) })];

    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    const types = [result.primaryCause?.type, ...result.contributingCauses.map((c) => c.type)];
    expect(types).toEqual(expect.arrayContaining([ExceptionType.PACKING_DELAY, 'LOADING_DELAY']));
  });

  it('7. reports INSUFFICIENT_EVIDENCE when no dispatch record and nothing correlates', async () => {
    const result = await analyzer.analyze(buildException(), buildEvidence() as unknown as Record<string, unknown>);

    expect(result.primaryCause).toBeNull();
    expect(result.limitations.some((l) => l.includes('No dispatch record exists'))).toBe(true);
  });
});
