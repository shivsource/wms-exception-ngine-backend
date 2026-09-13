import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TEST 9 / section 15's six business scenarios: the complete closed loop —
 * Exception -> Evidence -> Root Cause -> Recommendation -> Action -> Execution -> Outcome ->
 * Impact — run entirely against MockLogisticsDataSource, exactly like
 * src/canonical/mock-pipeline.test.ts does for the earlier layers. If this suite passes, the
 * Action Engine is proven to reuse the existing intelligence layer's outputs/contracts rather
 * than re-deriving anything, and to depend only on the canonical model + LogisticsDataSource.
 */
vi.mock('../adapters', async () => {
  const { MockLogisticsDataSource } = await import('../adapters/mock');
  return { logisticsDataSource: new MockLogisticsDataSource() };
});
vi.mock('../repositories', () => ({
  exceptionRepository: { findAllByType: vi.fn().mockResolvedValue([]) },
}));

import { logisticsDataSource } from '../adapters';
import { MockLogisticsDataSource } from '../adapters/mock';
import { exceptionRepository } from '../repositories';
import {
  DispatchDelayEvidenceCollector,
  InventoryDiscrepancyEvidenceCollector,
  InventoryShortageEvidenceCollector,
  PackingDelayEvidenceCollector,
  PickingDelayEvidenceCollector,
  SlaAtRiskEvidenceCollector,
} from '../evidence';
import { Action, PersistedException } from '../interfaces';
import {
  DispatchDelayAnalyzer,
  InventoryDiscrepancyAnalyzer,
  InventoryShortageAnalyzer,
  PackingDelayAnalyzer,
  PickingDelayAnalyzer,
  SlaAtRiskAnalyzer,
} from '../root-cause';
import {
  DispatchDelayRecommender,
  InventoryDiscrepancyRecommender,
  InventoryShortageRecommender,
  PackingDelayRecommender,
  PickingDelayRecommender,
  SlaAtRiskRecommender,
} from '../recommendation';
import {
  DispatchDelayRule,
  InventoryDiscrepancyRule,
  InventoryShortageRule,
  PackingDelayRule,
  PickingDelayRule,
  SlaAtRiskRule,
} from '../rules';
import { ActionStatus, ExceptionStatus, ExceptionType, OutcomeResult } from '../types/enums';
import { isUnmappable, mapRecommendationToAction } from './action-mapper';
import { computeImpact } from './impact-engine';
import { deriveOutcomeResult } from './outcome-engine';
import { actionSimulatorRegistry } from './simulator-registry';

const mockDataSource = logisticsDataSource as unknown as MockLogisticsDataSource;
const findAllByType = vi.mocked(exceptionRepository.findAllByType);

const now = () => new Date();
const minutesAgo = (m: number) => new Date(now().getTime() - m * 60_000);
const minutesFromNow = (m: number) => new Date(now().getTime() + m * 60_000);

function seed(overrides: MockLogisticsDataSourceSeedShape): void {
  mockDataSource.seed({ orders: [], products: [], inventory: [], pickingTasks: [], packing: [], dispatch: [], returns: [], ...overrides });
}
type MockLogisticsDataSourceSeedShape = Parameters<MockLogisticsDataSource['seed']>[0];

function toPersisted(detected: { type: ExceptionType; severity: PersistedException['severity']; entityType: PersistedException['entityType']; entityId: string; title: string; description: string; evidence: Record<string, unknown>; detectedAt: Date }): PersistedException {
  return {
    id: 1,
    exceptionId: `EXC-e2e-${detected.entityId}`,
    type: detected.type,
    entityType: detected.entityType,
    entityId: detected.entityId,
    severity: detected.severity,
    status: ExceptionStatus.OPEN,
    title: detected.title,
    description: detected.description,
    evidence: detected.evidence,
    detectedAt: detected.detectedAt,
    resolvedAt: null,
    createdAt: detected.detectedAt,
    updatedAt: detected.detectedAt,
  };
}

/** Fakes what ActionRepository.create would persist — this suite proves the engine logic offline,
 *  without a database (see repositories/action.repository.ts for the real persistence). */
function toAction(exception: PersistedException, mapping: { actionType: Action['actionType']; title: string; reason: string; parameters: Record<string, unknown> }): Action {
  return {
    id: 1,
    actionId: 'ACT-e2e-1',
    exceptionDbId: exception.id,
    exceptionId: exception.exceptionId,
    exceptionType: exception.type,
    recommendationDbId: 1,
    recommendationId: 'REC-e2e-1',
    actionType: mapping.actionType,
    status: ActionStatus.PROPOSED,
    title: mapping.title,
    reason: mapping.reason,
    parameters: mapping.parameters,
    createdAt: now(),
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    updatedAt: now(),
  };
}

describe('Action Engine: full closed loop for the six required business scenarios', () => {
  beforeEach(() => {
    seed({});
    findAllByType.mockReset();
    findAllByType.mockResolvedValue([]);
  });

  it('1. PICKING_DELAY -> REASSIGN_PICKER, simulated, with a positive outcome', async () => {
    seed({
      orders: [{ orderId: 'ORD-1', customerId: 'CUST-1', priority: 'NORMAL', orderTime: minutesAgo(150), expectedDispatchTime: minutesFromNow(30), status: 'PICKING', items: [] }],
      pickingTasks: [
        {
          taskId: 'TASK-1', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A1',
          startTime: minutesAgo(90), endTime: null, errors: 0, distanceWalked: null, status: 'IN_PROGRESS',
          items: [{ sku: 'SKU-1', locationId: 'A1', requestedQuantity: 5, pickedQuantity: 0, errorReason: null }],
        },
        { taskId: 'TASK-2', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A2', startTime: minutesAgo(10), endTime: null, errors: 0, distanceWalked: null, status: 'ASSIGNED', items: [] },
        { taskId: 'TASK-3', orderId: 'ORD-1', pickerId: 'PICKER-1', locationId: 'A3', startTime: minutesAgo(10), endTime: null, errors: 0, distanceWalked: null, status: 'ASSIGNED', items: [] },
        { taskId: 'TASK-4', orderId: 'ORD-2', pickerId: 'PICKER-2', locationId: 'A4', startTime: minutesAgo(30), endTime: now(), errors: 0, distanceWalked: 50, status: 'COMPLETED', items: [] },
      ],
    });

    const detected = await new PickingDelayRule().evaluate();
    const exception = toPersisted(detected[0]);
    const evidence = await new PickingDelayEvidenceCollector().collect(exception);
    const rootCause = await new PickingDelayAnalyzer().analyze(exception, evidence!);
    const recommendation = await new PickingDelayRecommender().recommend(exception, evidence, rootCause);

    const mapping = mapRecommendationToAction(exception, recommendation);
    expect(isUnmappable(mapping)).toBe(false);
    if (isUnmappable(mapping)) return;

    const action = toAction(exception, mapping);
    const simulator = actionSimulatorRegistry.get(action.actionType);
    expect(simulator).toBeDefined();

    const simulation = await simulator!.simulate(action, exception);
    expect(simulation.success).toBe(true);

    const impact = computeImpact(action, exception, simulation);
    const outcome = deriveOutcomeResult(impact, simulation.success);
    expect(outcome).not.toBe(OutcomeResult.FAILED);
  });

  it('2. INVENTORY_SHORTAGE -> REPLENISH_INVENTORY, simulated, restoring stock to the reorder level', async () => {
    seed({
      products: [{ sku: 'SKU-1', name: 'Widget', category: 'Tools', reorderLevel: 20, active: true }],
      inventory: [{ sku: 'SKU-1', locationId: 'A1', quantity: 10, reservedQuantity: 0, damagedQuantity: 0, availableQuantity: 10, lastUpdated: now() }],
    });

    const detected = await new InventoryShortageRule().evaluate();
    const exception = toPersisted(detected[0]);
    const evidence = await new InventoryShortageEvidenceCollector().collect(exception);
    const rootCause = await new InventoryShortageAnalyzer().analyze(exception, evidence!);
    const recommendation = await new InventoryShortageRecommender().recommend(exception, evidence, rootCause);

    const mapping = mapRecommendationToAction(exception, recommendation);
    expect(isUnmappable(mapping)).toBe(false);
    if (isUnmappable(mapping)) return;

    const action = toAction(exception, mapping);
    const simulator = actionSimulatorRegistry.get(action.actionType)!;
    const simulation = await simulator.simulate(action, exception);
    expect(simulation.success).toBe(true);
    expect((simulation.after as { totalAvailable: number }).totalAvailable).toBe(20);

    const impact = computeImpact(action, exception, simulation);
    const outcome = deriveOutcomeResult(impact, simulation.success);
    expect(outcome).toBe(OutcomeResult.SUCCESS);
  });

  it('3. INVENTORY_DISCREPANCY (DAMAGED_INVENTORY cause) -> RECHECK_INVENTORY, simulated, reconciling damaged quantity', async () => {
    // damagedQuantity > quantity drives DAMAGED_INVENTORY (score 70, since damaged > reserved
    // too), which outranks the residual STOCK_RECORD_ERROR cause (reservedQuantity <= quantity
    // here, so it never scores) — DAMAGED_INVENTORY's VERIFY/CHECK_INVENTORY candidates are both
    // mappable, unlike STOCK_RECORD_ERROR's top pick (INVESTIGATE, RECOMMENDATION_ONLY by design).
    seed({
      inventory: [{ sku: 'SKU-2', locationId: 'B1', quantity: 5, reservedQuantity: 3, damagedQuantity: 8, availableQuantity: 2, lastUpdated: now() }],
      products: [{ sku: 'SKU-2', name: 'Gadget', category: null, reorderLevel: null, active: true }],
    });

    const detected = await new InventoryDiscrepancyRule().evaluate();
    const exception = toPersisted(detected[0]);
    const evidence = await new InventoryDiscrepancyEvidenceCollector().collect(exception);
    const rootCause = await new InventoryDiscrepancyAnalyzer().analyze(exception, evidence!);
    expect(rootCause.primaryCause?.type).toBe('DAMAGED_INVENTORY');
    const recommendation = await new InventoryDiscrepancyRecommender().recommend(exception, evidence, rootCause);

    const mapping = mapRecommendationToAction(exception, recommendation);
    expect(isUnmappable(mapping)).toBe(false);
    if (isUnmappable(mapping)) return;

    const action = toAction(exception, mapping);
    const simulator = actionSimulatorRegistry.get(action.actionType)!;
    const simulation = await simulator.simulate(action, exception);
    expect(simulation.success).toBe(true);
    expect((simulation.after as { damagedQuantity: number }).damagedQuantity).toBe(5);
  });

  it('4. PACKING_DELAY -> a mappable, simulatable Action with a non-FAILED outcome', async () => {
    seed({
      orders: [{ orderId: 'ORD-4', customerId: 'CUST-1', priority: null, orderTime: minutesAgo(180), expectedDispatchTime: minutesFromNow(60), status: 'PICKING', items: [] }],
      pickingTasks: [{ taskId: 'TASK-4', orderId: 'ORD-4', pickerId: 'PICKER-1', locationId: 'A1', startTime: minutesAgo(120), endTime: minutesAgo(90), errors: 0, distanceWalked: 100, status: 'COMPLETED', items: [] }],
    });
    // Correlate a real upstream PICKING_DELAY exception for this order (mirrors
    // PackingDelayAnalyzer's own correlation) so the recommendation isn't the MONITOR fallback.
    findAllByType.mockImplementation(async (type: ExceptionType) => {
      if (type === ExceptionType.PICKING_DELAY) {
        return [
          toPersisted({
            type: ExceptionType.PICKING_DELAY,
            severity: 'HIGH' as PersistedException['severity'],
            entityType: 'PICKING_TASK' as PersistedException['entityType'],
            entityId: 'TASK-4',
            title: 'Picking delay',
            description: '',
            evidence: { taskCode: 'TASK-4', pickerId: 'PICKER-1', orderId: 'ORD-4', elapsedMinutes: 90 },
            detectedAt: now(),
          }),
        ];
      }
      return [];
    });

    const detected = await new PackingDelayRule().evaluate();
    const exception = toPersisted(detected[0]);
    const evidence = await new PackingDelayEvidenceCollector().collect(exception);
    const rootCause = await new PackingDelayAnalyzer().analyze(exception, evidence!);
    expect(rootCause.primaryCause?.type).toBe(ExceptionType.PICKING_DELAY);
    const recommendation = await new PackingDelayRecommender().recommend(exception, evidence, rootCause);

    const mapping = mapRecommendationToAction(exception, recommendation);
    expect(isUnmappable(mapping)).toBe(false);
    if (isUnmappable(mapping)) return;

    const action = toAction(exception, mapping);
    const simulator = actionSimulatorRegistry.get(action.actionType)!;
    const simulation = await simulator.simulate(action, exception);
    const impact = computeImpact(action, exception, simulation);
    const outcome = deriveOutcomeResult(impact, simulation.success);
    expect(outcome).not.toBe(OutcomeResult.FAILED);
  });

  it('5. DISPATCH_DELAY (LOADING_DELAY cause) -> a mappable, simulatable Action with a non-FAILED outcome', async () => {
    seed({
      orders: [{ orderId: 'ORD-5', customerId: 'CUST-1', priority: 'HIGH', orderTime: minutesAgo(200), expectedDispatchTime: minutesFromNow(10), status: 'PACKING', items: [] }],
      packing: [{ orderId: 'ORD-5', packingTime: minutesAgo(90), packageSize: 'M', weight: 2, damaged: false, packedBy: 'PACKER-1' }],
      dispatch: [{ orderId: 'ORD-5', truckId: 'TRUCK-1', carrier: 'CARRIER-1', dock: 'DOCK-1', loadingTime: minutesAgo(70), departureTime: null }],
    });

    const detected = await new DispatchDelayRule().evaluate();
    const exception = toPersisted(detected[0]);
    const evidence = await new DispatchDelayEvidenceCollector().collect(exception);
    const rootCause = await new DispatchDelayAnalyzer().analyze(exception, evidence!);
    expect(rootCause.primaryCause?.type).toBe('LOADING_DELAY');
    const recommendation = await new DispatchDelayRecommender().recommend(exception, evidence, rootCause);

    const mapping = mapRecommendationToAction(exception, recommendation);
    expect(isUnmappable(mapping)).toBe(false);
    if (isUnmappable(mapping)) return;

    const action = toAction(exception, mapping);
    const simulator = actionSimulatorRegistry.get(action.actionType)!;
    const simulation = await simulator.simulate(action, exception);
    const impact = computeImpact(action, exception, simulation);
    const outcome = deriveOutcomeResult(impact, simulation.success);
    expect(outcome).not.toBe(OutcomeResult.FAILED);
  });

  it('6. SLA_AT_RISK -> PRIORITIZE_ORDER, recovering a correlated upstream PICKING_DELAY wait, with SUCCESS', async () => {
    seed({
      orders: [{ orderId: 'ORD-3', customerId: 'CUST-1', priority: 'HIGH', orderTime: minutesAgo(120), expectedDispatchTime: minutesFromNow(30), status: 'PICKING', items: [] }],
    });

    const detected = await new SlaAtRiskRule().evaluate();
    const exception = toPersisted(detected[0]);
    const evidence = await new SlaAtRiskEvidenceCollector().collect(exception);
    const rootCause = await new SlaAtRiskAnalyzer().analyze(exception, evidence!);
    const recommendation = await new SlaAtRiskRecommender().recommend(exception, evidence, rootCause);

    expect(recommendation.recommendation.actionType).toBe('PRIORITIZE');
    const mapping = mapRecommendationToAction(exception, recommendation);
    expect(isUnmappable(mapping)).toBe(false);
    if (isUnmappable(mapping)) return;

    // Simulating execution: correlate a real upstream PICKING_DELAY exception for this order so
    // the simulator has an actual wait to recover (mirrors SlaAtRiskAnalyzer's own correlation).
    findAllByType.mockImplementation(async (type: ExceptionType) => {
      if (type === ExceptionType.PICKING_DELAY) {
        return [
          toPersisted({
            type: ExceptionType.PICKING_DELAY,
            severity: exception.severity,
            entityType: exception.entityType,
            entityId: 'TASK-1',
            title: 'Picking delay',
            description: '',
            evidence: { taskCode: 'TASK-1', pickerId: 'PICKER-1', orderId: 'ORD-3', elapsedMinutes: 90 },
            detectedAt: now(),
          }),
        ];
      }
      return [];
    });

    const action = toAction(exception, mapping);
    const simulator = actionSimulatorRegistry.get(action.actionType)!;
    const simulation = await simulator.simulate(action, exception);
    expect(simulation.success).toBe(true);

    const impact = computeImpact(action, exception, simulation);
    const outcome = deriveOutcomeResult(impact, simulation.success);
    expect(outcome).toBe(OutcomeResult.SUCCESS);
    expect(impact.percentageImprovement).toBeGreaterThan(0);
  });
});
