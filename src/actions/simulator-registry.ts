import { ActionSimulator } from '../interfaces';
import { ActionType } from '../types/enums';
import { EscalateOperationSimulator } from './simulators/escalate-operation.simulator';
import { MoveInventorySimulator } from './simulators/move-inventory.simulator';
import { PrioritizeOrderSimulator } from './simulators/prioritize-order.simulator';
import { ReassignPickerSimulator } from './simulators/reassign-picker.simulator';
import { RecheckInventorySimulator } from './simulators/recheck-inventory.simulator';
import { ReplenishInventorySimulator } from './simulators/replenish-inventory.simulator';

export * from './simulators/escalate-operation.simulator';
export * from './simulators/move-inventory.simulator';
export * from './simulators/prioritize-order.simulator';
export * from './simulators/reassign-picker.simulator';
export * from './simulators/recheck-inventory.simulator';
export * from './simulators/replenish-inventory.simulator';

/**
 * Single source of truth for which simulator handles which ActionType. Adding simulation
 * support for a new ActionType means writing the simulator class in src/actions/simulators/
 * and adding one line here — ActionExecutionService never needs to change. Mirrors
 * RecommendationAnalyzerRegistry (src/recommendation/index.ts).
 */
export class ActionSimulatorRegistry {
  private readonly byType: ReadonlyMap<ActionType, ActionSimulator>;

  constructor(simulators: ActionSimulator[]) {
    this.byType = new Map(simulators.map((simulator) => [simulator.actionType, simulator]));
  }

  get(type: ActionType): ActionSimulator | undefined {
    return this.byType.get(type);
  }
}

export const actionSimulatorRegistry = new ActionSimulatorRegistry([
  new ReassignPickerSimulator(),
  new MoveInventorySimulator(),
  new ReplenishInventorySimulator(),
  new RecheckInventorySimulator(),
  new PrioritizeOrderSimulator(),
  new EscalateOperationSimulator(),
]);
