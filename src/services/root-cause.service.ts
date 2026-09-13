import { rootCauseAnalyzerRegistry } from '../root-cause';
import { PersistedException, RootCauseAnalysis } from '../interfaces';

/**
 * Thin dispatcher: looks up the registered analyzer for the exception's type and
 * delegates to it. All per-type correlation/scoring logic lives in src/root-cause/ —
 * this class has no business logic of its own, mirroring evidence.service.ts.
 */
export class RootCauseService {
  async analyze(
    exception: PersistedException,
    evidence: Record<string, unknown> | null,
  ): Promise<RootCauseAnalysis | null> {
    if (!evidence) return null;

    const analyzer = rootCauseAnalyzerRegistry.get(exception.type);
    if (!analyzer) return null;

    return analyzer.analyze(exception, evidence);
  }
}

export const rootCauseService = new RootCauseService();
