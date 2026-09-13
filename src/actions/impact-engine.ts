import { thresholds } from '../config/thresholds';
import { Action, ActionImpact, ImpactMetric, PersistedException, SimulationResult } from '../interfaces';
import { ActionType, EntityType, ExceptionSeverity, ExceptionType } from '../types/enums';
import { classifyBySeverityThresholds } from '../utils/severity';

/**
 * Turns a SimulationResult's before/after state into business impact — the Impact Engine's
 * whole job (see ARCHITECTURE additions for this phase). Every number here is read directly
 * off the simulation's before/after state (itself grounded in real WMS data, see each
 * simulator) — nothing here fabricates a financial figure, since this schema has no reliable
 * cost data (per instruction: don't invent cost if the dataset can't support it).
 */
export function computeImpact(action: Action, exception: PersistedException, simulation: SimulationResult): ActionImpact {
  const base: Omit<ActionImpact, 'metrics' | 'minutesSaved' | 'percentageImprovement' | 'slaRecovered' | 'severityChange' | 'notes'> = {
    actionId: action.actionId,
    ordersAffected: exception.entityType === EntityType.ORDER ? 1 : 0,
    tasksAffected: exception.entityType === EntityType.PICKING_TASK ? 1 : 0,
  };

  if (!simulation.success) {
    return {
      ...base,
      metrics: [],
      minutesSaved: null,
      percentageImprovement: null,
      slaRecovered: null,
      severityChange: null,
      notes: ['Simulation did not succeed; no impact can be computed.', ...simulation.notes],
    };
  }

  switch (action.actionType) {
    case ActionType.REASSIGN_PICKER:
      return { ...base, ...fromTimeMetric(simulation, 'PICKING_TIME'), severityChange: severityFor(exception, classifyBySeverityThresholds(
        (simulation.after as { pickingTimeMinutes: number }).pickingTimeMinutes,
        thresholds.pickingDelay.severity,
      )) };

    case ActionType.PRIORITIZE_ORDER:
      return computePrioritizeOrderImpact(action, exception, simulation, base);

    case ActionType.REPLENISH_INVENTORY:
      return computeReplenishImpact(exception, simulation, base);

    case ActionType.RECHECK_INVENTORY:
      return computeRecheckImpact(exception, simulation, base);

    case ActionType.MOVE_INVENTORY: {
      const before = simulation.before as { availableAtLocation?: number };
      const after = simulation.after as { availableAtLocation?: number };
      const metrics: ImpactMetric[] = [
        { metric: 'INVENTORY_AVAILABILITY', before: before.availableAtLocation ?? 0, after: after.availableAtLocation ?? 0, unit: 'UNITS' },
      ];
      return {
        ...base,
        metrics,
        minutesSaved: null,
        percentageImprovement: null,
        slaRecovered: null,
        severityChange: null,
        notes: ['Relocating the pick resolves the shortage for this task without a directly comparable before/after time metric.'],
      };
    }

    case ActionType.ESCALATE_OPERATION:
      return {
        ...base,
        metrics: [],
        minutesSaved: null,
        percentageImprovement: null,
        slaRecovered: null,
        severityChange: null,
        notes: ['ESCALATE_OPERATION has no quantitative operational metric in this schema; impact is qualitative (supervisor notified).'],
      };

    default:
      return { ...base, metrics: [], minutesSaved: null, percentageImprovement: null, slaRecovered: null, severityChange: null, notes: [] };
  }
}

function fromTimeMetric(
  simulation: SimulationResult,
  metricName: string,
): Pick<ActionImpact, 'metrics' | 'minutesSaved' | 'percentageImprovement' | 'slaRecovered' | 'notes'> {
  const before = (simulation.before as { pickingTimeMinutes: number }).pickingTimeMinutes;
  const after = (simulation.after as { pickingTimeMinutes: number }).pickingTimeMinutes;
  const minutesSaved = before - after;
  return {
    metrics: [{ metric: metricName, before, after, unit: 'MINUTES' }],
    minutesSaved,
    percentageImprovement: before > 0 ? round2((minutesSaved / before) * 100) : null,
    slaRecovered: null,
    notes: simulation.notes,
  };
}

function computePrioritizeOrderImpact(
  action: Action,
  exception: PersistedException,
  simulation: SimulationResult,
  base: Pick<ActionImpact, 'actionId' | 'ordersAffected' | 'tasksAffected'>,
): ActionImpact {
  const params = action.parameters as { exceptionType: ExceptionType };
  const metrics: ImpactMetric[] = [];
  let minutesSaved: number | null = null;
  let percentageImprovement: number | null = null;
  let slaRecovered: boolean | null = null;
  let severityChange: ActionImpact['severityChange'] = null;

  if (params.exceptionType === ExceptionType.SLA_AT_RISK) {
    const before = simulation.before as { minutesRemaining: number; upstreamWaitingMinutes: number };
    const after = simulation.after as { minutesRemaining: number; upstreamWaitingMinutes: number };
    metrics.push({ metric: 'SLA_MINUTES_REMAINING', before: before.minutesRemaining, after: after.minutesRemaining, unit: 'MINUTES' });
    minutesSaved = after.minutesRemaining - before.minutesRemaining;
    slaRecovered = before.minutesRemaining <= 0 && after.minutesRemaining > 0;
    const windowMinutes = thresholds.slaAtRisk.windowMinutes;
    const beforeRatio = 1 - before.minutesRemaining / windowMinutes;
    const afterRatio = 1 - after.minutesRemaining / windowMinutes;
    severityChange = {
      before: exception.severity,
      after: classifyBySeverityThresholds(Math.max(afterRatio, 0), thresholds.slaAtRisk.severity),
    };
    percentageImprovement = beforeRatio > 0 ? round2(((beforeRatio - Math.max(afterRatio, 0)) / beforeRatio) * 100) : null;
  } else {
    const before = simulation.before as { waitingMinutes: number };
    const after = simulation.after as { waitingMinutes: number };
    metrics.push({ metric: 'QUEUE_WAIT', before: before.waitingMinutes, after: after.waitingMinutes, unit: 'MINUTES' });
    minutesSaved = before.waitingMinutes - after.waitingMinutes;
    percentageImprovement = before.waitingMinutes > 0 ? round2((minutesSaved / before.waitingMinutes) * 100) : null;
    if (params.exceptionType === ExceptionType.PACKING_DELAY) {
      severityChange = { before: exception.severity, after: classifyBySeverityThresholds(after.waitingMinutes, thresholds.packingDelay.severity) };
    } else if (params.exceptionType === ExceptionType.DISPATCH_DELAY) {
      severityChange = { before: exception.severity, after: classifyBySeverityThresholds(after.waitingMinutes, thresholds.dispatchDelay.severity) };
    } else if (params.exceptionType === ExceptionType.PICKING_DELAY) {
      severityChange = { before: exception.severity, after: classifyBySeverityThresholds(after.waitingMinutes, thresholds.pickingDelay.severity) };
    }
  }

  return { ...base, metrics, minutesSaved, percentageImprovement, slaRecovered, severityChange, notes: simulation.notes };
}

function computeReplenishImpact(
  exception: PersistedException,
  simulation: SimulationResult,
  base: Pick<ActionImpact, 'actionId' | 'ordersAffected' | 'tasksAffected'>,
): ActionImpact {
  const before = simulation.before as { totalAvailable: number; shortfallUnits: number };
  const after = simulation.after as { totalAvailable: number; shortfallUnits: number };
  const metrics: ImpactMetric[] = [
    { metric: 'INVENTORY_AVAILABILITY', before: before.totalAvailable, after: after.totalAvailable, unit: 'UNITS' },
    { metric: 'SHORTFALL', before: before.shortfallUnits, after: after.shortfallUnits, unit: 'UNITS' },
  ];
  const percentageImprovement = before.shortfallUnits > 0 ? round2(((before.shortfallUnits - after.shortfallUnits) / before.shortfallUnits) * 100) : null;

  // Mirrors InventoryShortageRule's own severity classification, using the projected after-state
  // (shortfallRatio = shortfallUnits / reorderLevel; after.totalAvailable === reorderLevel by
  // construction once replenished, so after.shortfallUnits is always 0 unless replenishment failed).
  const t = thresholds.inventoryShortage;
  const afterRatio = after.totalAvailable > 0 ? after.shortfallUnits / after.totalAvailable : 0;

  return {
    ...base,
    metrics,
    minutesSaved: null,
    percentageImprovement,
    slaRecovered: null,
    severityChange: { before: exception.severity, after: classifyBySeverityThresholds(afterRatio, t) },
    notes: simulation.notes,
  };
}

function computeRecheckImpact(
  exception: PersistedException,
  simulation: SimulationResult,
  base: Pick<ActionImpact, 'actionId' | 'ordersAffected' | 'tasksAffected'>,
): ActionImpact {
  const before = simulation.before as { quantity: number; reservedQuantity: number; damagedQuantity: number };
  const after = simulation.after as { quantity: number; reservedQuantity: number; damagedQuantity: number };
  const beforeExcess = Math.max(before.reservedQuantity - before.quantity, before.damagedQuantity - before.quantity, 0);
  const afterExcess = Math.max(after.reservedQuantity - after.quantity, after.damagedQuantity - after.quantity, 0);
  const metrics: ImpactMetric[] = [
    { metric: 'RESERVED_QUANTITY_EXCESS', before: Math.max(before.reservedQuantity - before.quantity, 0), after: Math.max(after.reservedQuantity - after.quantity, 0), unit: 'UNITS' },
    { metric: 'DAMAGED_QUANTITY_EXCESS', before: Math.max(before.damagedQuantity - before.quantity, 0), after: Math.max(after.damagedQuantity - after.quantity, 0), unit: 'UNITS' },
  ];
  const percentageImprovement = beforeExcess > 0 ? round2(((beforeExcess - afterExcess) / beforeExcess) * 100) : null;
  const ratio = after.quantity > 0 ? afterExcess / after.quantity : afterExcess > 0 ? 1 : 0;

  return {
    ...base,
    metrics,
    minutesSaved: null,
    percentageImprovement,
    slaRecovered: null,
    severityChange: { before: exception.severity, after: classifyBySeverityThresholds(ratio, thresholds.inventoryDiscrepancy) },
    notes: simulation.notes,
  };
}

function severityFor(exception: PersistedException, after: ExceptionSeverity): ActionImpact['severityChange'] {
  return { before: exception.severity, after };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
