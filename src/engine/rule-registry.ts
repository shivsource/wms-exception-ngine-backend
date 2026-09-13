import { ExceptionRule } from '../interfaces';
import {
  DispatchDelayRule,
  ExcessivePickerDistanceRule,
  ExcessivePickingTimeRule,
  HighReturnRateRule,
  InventoryDiscrepancyRule,
  InventoryShortageRule,
  PackingDelayRule,
  PickingDelayRule,
  PickingErrorRule,
  SlaAtRiskRule,
} from '../rules';

/**
 * Single source of truth for which rules the engine runs. Adding a new exception
 * type means writing the rule class in src/rules/ and adding one line here —
 * nothing in the engine or scheduler ever needs to change.
 */
export class RuleRegistry {
  private readonly rules: ExceptionRule[] = [
    new InventoryShortageRule(),
    new InventoryDiscrepancyRule(),
    new PickingDelayRule(),
    new PickingErrorRule(),
    new ExcessivePickingTimeRule(),
    new ExcessivePickerDistanceRule(),
    new SlaAtRiskRule(),
    new PackingDelayRule(),
    new DispatchDelayRule(),
    new HighReturnRateRule(),
  ];

  getAll(): ExceptionRule[] {
    return this.rules;
  }
}

export const ruleRegistry = new RuleRegistry();
