import { ExplanationGenerator, HighReturnRateEvidence, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class HighReturnRateExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.HIGH_RETURN_RATE;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { product, totalReturned, totalOrdered, returnRatePercentage, windowDays, recentReturns } =
      evidence as unknown as HighReturnRateEvidence;

    const sentences = [
      `${product.productName ?? product.sku} (${product.sku}) was returned ${totalReturned} time(s) out of ${totalOrdered} ordered in the last ${windowDays} days (${returnRatePercentage}%).`,
    ];

    if (recentReturns.length > 0) {
      const reasonCounts = new Map<string, number>();
      for (const ret of recentReturns) {
        reasonCounts.set(ret.reason, (reasonCounts.get(ret.reason) ?? 0) + 1);
      }
      const reasonSummary = [...reasonCounts.entries()].map(([reason, count]) => `${reason} (${count})`).join(', ');
      sentences.push(`Recorded return reasons: ${reasonSummary}.`);
    }

    return sentences.join(' ');
  }
}
