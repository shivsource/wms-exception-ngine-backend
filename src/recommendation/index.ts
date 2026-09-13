import { RecommendationAnalyzer } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { DispatchDelayRecommender } from './dispatch-delay.recommender';
import { ExcessivePickerDistanceRecommender } from './excessive-picker-distance.recommender';
import { ExcessivePickingTimeRecommender } from './excessive-picking-time.recommender';
import { HighReturnRateRecommender } from './high-return-rate.recommender';
import { InventoryDiscrepancyRecommender } from './inventory-discrepancy.recommender';
import { InventoryShortageRecommender } from './inventory-shortage.recommender';
import { PackingDelayRecommender } from './packing-delay.recommender';
import { PickingDelayRecommender } from './picking-delay.recommender';
import { PickingErrorRecommender } from './picking-error.recommender';
import { SlaAtRiskRecommender } from './sla-at-risk.recommender';

export * from './dispatch-delay.recommender';
export * from './excessive-picker-distance.recommender';
export * from './excessive-picking-time.recommender';
export * from './high-return-rate.recommender';
export * from './inventory-discrepancy.recommender';
export * from './inventory-shortage.recommender';
export * from './packing-delay.recommender';
export * from './picking-delay.recommender';
export * from './picking-error.recommender';
export * from './sla-at-risk.recommender';

/**
 * Single source of truth for which recommender handles which exception type. Adding
 * recommendation support for a new type means writing the recommender class in this
 * directory and adding one line here — RecommendationService never needs to change.
 */
export class RecommendationAnalyzerRegistry {
  private readonly byType: ReadonlyMap<ExceptionType, RecommendationAnalyzer>;

  constructor(analyzers: RecommendationAnalyzer[]) {
    this.byType = new Map(analyzers.map((analyzer) => [analyzer.exceptionType, analyzer]));
  }

  get(type: ExceptionType): RecommendationAnalyzer | undefined {
    return this.byType.get(type);
  }
}

export const recommendationAnalyzerRegistry = new RecommendationAnalyzerRegistry([
  new PickingDelayRecommender(),
  new PickingErrorRecommender(),
  new InventoryShortageRecommender(),
  new InventoryDiscrepancyRecommender(),
  new SlaAtRiskRecommender(),
  new ExcessivePickerDistanceRecommender(),
  new ExcessivePickingTimeRecommender(),
  new PackingDelayRecommender(),
  new DispatchDelayRecommender(),
  new HighReturnRateRecommender(),
]);
