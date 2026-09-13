import { evidenceCollectorRegistry } from '../evidence';
import { PersistedException } from '../interfaces';

/**
 * Thin dispatcher: looks up the registered collector for the exception's type and
 * delegates to it. All per-type querying logic lives in src/evidence/ — this class
 * has no SQL and no business logic of its own.
 */
export class EvidenceService {
  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const collector = evidenceCollectorRegistry.get(exception.type);
    if (!collector) return null;
    return collector.collect(exception);
  }
}

export const evidenceService = new EvidenceService();
