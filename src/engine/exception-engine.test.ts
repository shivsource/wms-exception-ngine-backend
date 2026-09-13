import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DetectedException, ExceptionRule, PersistedException } from '../interfaces';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

/**
 * exception-engine.ts had no dedicated test file (unlike prediction-engine.test.ts) — this
 * covers its orchestration logic directly: persistence, duplicate detection, and the
 * OPEN-only re-creation semantics that section 17's lifecycle questions (creation, duplicate
 * detection, resolution, re-running the engine, whether resolved exceptions are recreated)
 * turn on. Rules themselves are already covered per-type in src/rules/*.rule.test.ts and
 * src/canonical/mock-pipeline.test.ts.
 */
vi.mock('../repositories', () => ({
  exceptionRepository: { findExistingOpen: vi.fn(), create: vi.fn() },
}));
vi.mock('./rule-registry', () => ({
  ruleRegistry: { getAll: vi.fn() },
}));

import { exceptionRepository } from '../repositories';
import { ExceptionEngine } from './exception-engine';
import { ruleRegistry } from './rule-registry';

const findExistingOpen = vi.mocked(exceptionRepository.findExistingOpen);
const create = vi.mocked(exceptionRepository.create);
const getAll = vi.mocked(ruleRegistry.getAll);

function detected(overrides: Partial<DetectedException> = {}): DetectedException {
  return {
    type: ExceptionType.INVENTORY_SHORTAGE, severity: ExceptionSeverity.MEDIUM,
    entityType: EntityType.PRODUCT, entityId: 'SKU-1', title: 't', description: 'd',
    evidence: {}, detectedAt: new Date('2026-09-13T09:00:00.000Z'), ...overrides,
  };
}
function persisted(overrides: Partial<PersistedException> = {}): PersistedException {
  return {
    id: 1, exceptionId: 'EXC-1', type: ExceptionType.INVENTORY_SHORTAGE, entityType: EntityType.PRODUCT,
    entityId: 'SKU-1', severity: ExceptionSeverity.MEDIUM, status: ExceptionStatus.OPEN, title: 't',
    description: 'd', evidence: null, detectedAt: new Date(), resolvedAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}
function fakeRule(name: string, exceptionType: ExceptionType, result: DetectedException[] | Error): ExceptionRule {
  return {
    name, exceptionType,
    evaluate: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('ExceptionEngine', () => {
  beforeEach(() => {
    findExistingOpen.mockReset();
    create.mockReset();
    getAll.mockReset();
  });

  it('1. persists a newly detected exception when no OPEN exception exists for that entity', async () => {
    getAll.mockReturnValue([fakeRule('R1', ExceptionType.INVENTORY_SHORTAGE, [detected()])]);
    findExistingOpen.mockResolvedValue(null);
    create.mockResolvedValue(persisted());

    const summary = await new ExceptionEngine().run();

    expect(create).toHaveBeenCalledTimes(1);
    expect(summary.totalPersisted).toBe(1);
    expect(summary.totalDuplicates).toBe(0);
  });

  it('2. does not create a duplicate when an OPEN exception already exists for the same type/entity', async () => {
    getAll.mockReturnValue([fakeRule('R1', ExceptionType.INVENTORY_SHORTAGE, [detected()])]);
    findExistingOpen.mockResolvedValue(persisted()); // an OPEN row already exists

    const summary = await new ExceptionEngine().run();

    expect(create).not.toHaveBeenCalled();
    expect(summary.totalPersisted).toBe(0);
    expect(summary.totalDuplicates).toBe(1);
  });

  it('3. LIFECYCLE: once the existing exception is RESOLVED, findExistingOpen (status=OPEN only) no longer matches it, so a still-triggering condition creates a BRAND NEW exception rather than being blocked — resolving does not suppress re-detection', async () => {
    getAll.mockReturnValue([fakeRule('R1', ExceptionType.INVENTORY_SHORTAGE, [detected()])]);
    // findExistingOpen queries `status = 'OPEN'` (see exception.repository.ts) — a RESOLVED
    // row for this same entity/type is invisible to it, so it correctly returns null here,
    // exactly as it would if no exception had ever existed for this entity at all.
    findExistingOpen.mockResolvedValue(null);
    create.mockResolvedValue(persisted({ id: 2, exceptionId: 'EXC-2' }));

    const summary = await new ExceptionEngine().run();

    expect(create).toHaveBeenCalledTimes(1);
    expect(summary.totalPersisted).toBe(1);
  });

  it('4. a batch of detections from one rule is deduplicated independently per entity (mixed new + duplicate)', async () => {
    getAll.mockReturnValue([
      fakeRule('R1', ExceptionType.INVENTORY_SHORTAGE, [detected({ entityId: 'SKU-1' }), detected({ entityId: 'SKU-2' })]),
    ]);
    findExistingOpen.mockImplementation(async (_type, _entityType, entityId) => (entityId === 'SKU-1' ? persisted({ entityId: 'SKU-1' }) : null));
    create.mockResolvedValue(persisted({ entityId: 'SKU-2' }));

    const summary = await new ExceptionEngine().run();

    expect(create).toHaveBeenCalledTimes(1);
    expect(summary.totalPersisted).toBe(1);
    expect(summary.totalDuplicates).toBe(1);
    expect(summary.totalDetected).toBe(2);
  });

  it('5. records a per-rule error without aborting the run — other rules still execute and persist', async () => {
    getAll.mockReturnValue([
      fakeRule('FailingRule', ExceptionType.PICKING_DELAY, new Error('boom')),
      fakeRule('HealthyRule', ExceptionType.INVENTORY_SHORTAGE, [detected()]),
    ]);
    findExistingOpen.mockResolvedValue(null);
    create.mockResolvedValue(persisted());

    const summary = await new ExceptionEngine().run();

    expect(summary.rules[0].error).toBe('boom');
    expect(summary.rules[1].persistedCount).toBe(1);
    expect(summary.totalErrors).toBe(1);
    expect(summary.totalPersisted).toBe(1);
  });

  it('6. IDEMPOTENCY: running the engine twice in a row against an unchanged OPEN exception never creates a second row', async () => {
    getAll.mockReturnValue([fakeRule('R1', ExceptionType.INVENTORY_SHORTAGE, [detected()])]);
    findExistingOpen.mockResolvedValueOnce(null).mockResolvedValueOnce(persisted());
    create.mockResolvedValue(persisted());

    const first = await new ExceptionEngine().run();
    const second = await new ExceptionEngine().run();

    expect(create).toHaveBeenCalledTimes(1);
    expect(first.totalPersisted).toBe(1);
    expect(second.totalPersisted).toBe(0);
    expect(second.totalDuplicates).toBe(1);
  });
});
