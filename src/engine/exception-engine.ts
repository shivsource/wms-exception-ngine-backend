import { EngineRunSummary, RuleExecutionSummary } from '../interfaces';
import { exceptionRepository } from '../repositories';
import { logger } from '../utils/logger';
import { ruleRegistry } from './rule-registry';

/**
 * Orchestrates every registered rule. Contains no SQL and no business logic of its
 * own — it only knows how to run an ExceptionRule, deduplicate against already-open
 * exceptions, persist new ones, and report what happened.
 */
export class ExceptionEngine {
  async run(): Promise<EngineRunSummary> {
    const startedAt = new Date();
    const runStart = Date.now();
    const ruleSummaries: RuleExecutionSummary[] = [];

    for (const rule of ruleRegistry.getAll()) {
      const ruleStart = Date.now();
      try {
        const detected = await rule.evaluate();

        const outcomes = await Promise.all(
          detected.map(async (exception) => {
            const existing = await exceptionRepository.findExistingOpen(
              exception.type,
              exception.entityType,
              exception.entityId,
            );
            if (existing) return 'duplicate' as const;
            await exceptionRepository.create(exception);
            return 'persisted' as const;
          }),
        );

        const summary: RuleExecutionSummary = {
          ruleName: rule.name,
          exceptionType: rule.exceptionType,
          detectedCount: detected.length,
          persistedCount: outcomes.filter((o) => o === 'persisted').length,
          duplicateCount: outcomes.filter((o) => o === 'duplicate').length,
          durationMs: Date.now() - ruleStart,
        };
        ruleSummaries.push(summary);
        logger.info(`Rule executed: ${rule.name}`, { ...summary });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ruleSummaries.push({
          ruleName: rule.name,
          exceptionType: rule.exceptionType,
          detectedCount: 0,
          persistedCount: 0,
          duplicateCount: 0,
          durationMs: Date.now() - ruleStart,
          error: message,
        });
        logger.error(`Rule failed: ${rule.name}`, { error: message });
      }
    }

    const summary: EngineRunSummary = {
      startedAt,
      durationMs: Date.now() - runStart,
      rules: ruleSummaries,
      totalDetected: ruleSummaries.reduce((sum, r) => sum + r.detectedCount, 0),
      totalPersisted: ruleSummaries.reduce((sum, r) => sum + r.persistedCount, 0),
      totalDuplicates: ruleSummaries.reduce((sum, r) => sum + r.duplicateCount, 0),
      totalErrors: ruleSummaries.filter((r) => r.error).length,
    };

    logger.info('Exception engine run complete', {
      durationMs: summary.durationMs,
      totalDetected: summary.totalDetected,
      totalPersisted: summary.totalPersisted,
      totalDuplicates: summary.totalDuplicates,
      totalErrors: summary.totalErrors,
    });

    return summary;
  }
}

export const exceptionEngine = new ExceptionEngine();
