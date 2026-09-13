import { recommendationAnalyzerRegistry } from '../recommendation';
import { PersistedException, RecommendationResult, RootCauseAnalysis } from '../interfaces';

/**
 * Thin dispatcher: looks up the registered recommender for the exception's type and
 * delegates to it. All per-type candidate-action logic lives in src/recommendation/ —
 * this class has no business logic of its own, mirroring root-cause.service.ts.
 */
export class RecommendationService {
  async recommend(
    exception: PersistedException,
    evidence: Record<string, unknown> | null,
    rootCause: RootCauseAnalysis | null,
  ): Promise<RecommendationResult | null> {
    const analyzer = recommendationAnalyzerRegistry.get(exception.type);
    if (!analyzer) return null;

    return analyzer.recommend(exception, evidence, rootCause);
  }
}

export const recommendationService = new RecommendationService();
