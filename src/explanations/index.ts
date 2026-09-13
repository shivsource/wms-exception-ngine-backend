import { ExplanationGenerator } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { DispatchDelayExplanationGenerator } from './dispatch-delay.explanation';
import { ExcessivePickerDistanceExplanationGenerator } from './excessive-picker-distance.explanation';
import { ExcessivePickingTimeExplanationGenerator } from './excessive-picking-time.explanation';
import { HighReturnRateExplanationGenerator } from './high-return-rate.explanation';
import { InventoryDiscrepancyExplanationGenerator } from './inventory-discrepancy.explanation';
import { InventoryShortageExplanationGenerator } from './inventory-shortage.explanation';
import { PackingDelayExplanationGenerator } from './packing-delay.explanation';
import { PickingDelayExplanationGenerator } from './picking-delay.explanation';
import { PickingErrorExplanationGenerator } from './picking-error.explanation';
import { SlaAtRiskExplanationGenerator } from './sla-at-risk.explanation';

export * from './dispatch-delay.explanation';
export * from './excessive-picker-distance.explanation';
export * from './excessive-picking-time.explanation';
export * from './high-return-rate.explanation';
export * from './inventory-discrepancy.explanation';
export * from './inventory-shortage.explanation';
export * from './packing-delay.explanation';
export * from './picking-delay.explanation';
export * from './picking-error.explanation';
export * from './sla-at-risk.explanation';

/**
 * Single source of truth for which generator handles which exception type. Adding
 * explanation support for a new type means writing the generator class in this
 * directory and adding one line here — ExplanationService never needs to change.
 */
export class ExplanationGeneratorRegistry {
  private readonly byType: ReadonlyMap<ExceptionType, ExplanationGenerator>;

  constructor(generators: ExplanationGenerator[]) {
    this.byType = new Map(generators.map((generator) => [generator.exceptionType, generator]));
  }

  get(type: ExceptionType): ExplanationGenerator | undefined {
    return this.byType.get(type);
  }
}

export const explanationGeneratorRegistry = new ExplanationGeneratorRegistry([
  new PickingDelayExplanationGenerator(),
  new PickingErrorExplanationGenerator(),
  new ExcessivePickingTimeExplanationGenerator(),
  new ExcessivePickerDistanceExplanationGenerator(),
  new SlaAtRiskExplanationGenerator(),
  new PackingDelayExplanationGenerator(),
  new DispatchDelayExplanationGenerator(),
  new HighReturnRateExplanationGenerator(),
  new InventoryShortageExplanationGenerator(),
  new InventoryDiscrepancyExplanationGenerator(),
]);
