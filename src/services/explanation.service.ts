import { explanationGeneratorRegistry } from '../explanations';
import { PersistedException } from '../interfaces';

const NO_EVIDENCE_MESSAGE = 'No supporting evidence is available for this exception type yet.';

/**
 * Thin dispatcher: looks up the registered generator for the exception's type and
 * delegates to it. All per-type narrative templating lives in src/explanations/ —
 * this class has no LLM calls and no inference of its own.
 */
export class ExplanationService {
  explain(exception: PersistedException, evidence: Record<string, unknown> | null): string {
    if (!evidence) return NO_EVIDENCE_MESSAGE;

    const generator = explanationGeneratorRegistry.get(exception.type);
    if (!generator) return NO_EVIDENCE_MESSAGE;

    return generator.explain(exception, evidence);
  }
}

export const explanationService = new ExplanationService();
