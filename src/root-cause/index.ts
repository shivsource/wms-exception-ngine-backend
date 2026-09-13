import { RootCauseAnalyzer } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { DispatchDelayAnalyzer } from './dispatch-delay.analyzer';
import { ExcessivePickerDistanceAnalyzer } from './excessive-picker-distance.analyzer';
import { ExcessivePickingTimeAnalyzer } from './excessive-picking-time.analyzer';
import { HighReturnRateAnalyzer } from './high-return-rate.analyzer';
import { InventoryDiscrepancyAnalyzer } from './inventory-discrepancy.analyzer';
import { InventoryShortageAnalyzer } from './inventory-shortage.analyzer';
import { PackingDelayAnalyzer } from './packing-delay.analyzer';
import { PickingDelayAnalyzer } from './picking-delay.analyzer';
import { PickingErrorAnalyzer } from './picking-error.analyzer';
import { SlaAtRiskAnalyzer } from './sla-at-risk.analyzer';

export * from './dispatch-delay.analyzer';
export * from './excessive-picker-distance.analyzer';
export * from './excessive-picking-time.analyzer';
export * from './high-return-rate.analyzer';
export * from './inventory-discrepancy.analyzer';
export * from './inventory-shortage.analyzer';
export * from './packing-delay.analyzer';
export * from './picking-delay.analyzer';
export * from './picking-error.analyzer';
export * from './sla-at-risk.analyzer';

/**
 * Single source of truth for which analyzer handles which exception type. Adding root
 * cause support for a new type means writing the analyzer class in this directory and
 * adding one line here — RootCauseService never needs to change.
 */
export class RootCauseAnalyzerRegistry {
  private readonly byType: ReadonlyMap<ExceptionType, RootCauseAnalyzer>;

  constructor(analyzers: RootCauseAnalyzer[]) {
    this.byType = new Map(analyzers.map((analyzer) => [analyzer.exceptionType, analyzer]));
  }

  get(type: ExceptionType): RootCauseAnalyzer | undefined {
    return this.byType.get(type);
  }
}

export const rootCauseAnalyzerRegistry = new RootCauseAnalyzerRegistry([
  new PickingDelayAnalyzer(),
  new PickingErrorAnalyzer(),
  new InventoryShortageAnalyzer(),
  new InventoryDiscrepancyAnalyzer(),
  new SlaAtRiskAnalyzer(),
  new ExcessivePickerDistanceAnalyzer(),
  new ExcessivePickingTimeAnalyzer(),
  new PackingDelayAnalyzer(),
  new DispatchDelayAnalyzer(),
  new HighReturnRateAnalyzer(),
]);
