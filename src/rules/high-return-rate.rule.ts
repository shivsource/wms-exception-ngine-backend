import { logisticsDataSource } from '../adapters';
import { thresholds } from '../config/thresholds';
import { DetectedException, ExceptionRule } from '../interfaces';
import { getReturnCountsBySku } from '../queries';
import { EntityType, ExceptionSeverity, ExceptionType } from '../types/enums';
import { classifyBySeverityThresholds } from '../utils/severity';

export class HighReturnRateRule implements ExceptionRule {
  readonly name = 'HighReturnRateRule';
  readonly exceptionType = ExceptionType.HIGH_RETURN_RATE;

  async evaluate(): Promise<DetectedException[]> {
    const { windowDays, minOrderedForSignificance, severity: severityThresholds } =
      thresholds.highReturnRate;
    const detectedAt = new Date();
    const windowStart = new Date(detectedAt.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const [returns, orders] = await Promise.all([
      logisticsDataSource.getReturns({ returnedFrom: windowStart }),
      logisticsDataSource.getOrders({ orderTimeFrom: windowStart }),
    ]);
    const counts = getReturnCountsBySku(returns, orders);

    return counts
      .filter((row) => row.totalOrdered >= minOrderedForSignificance)
      .map((row) => {
        const rate = row.totalReturned / row.totalOrdered;
        return { row, rate, severity: classifyBySeverityThresholds(rate, severityThresholds) };
      })
      .filter(({ severity }) => severity !== ExceptionSeverity.LOW)
      .map(({ row, rate, severity }) => ({
        type: this.exceptionType,
        severity,
        entityType: EntityType.PRODUCT,
        entityId: row.sku,
        title: `High return rate for ${row.sku}`,
        description: `${row.sku} was returned ${row.totalReturned} time(s) out of ${row.totalOrdered} ordered in the last ${windowDays} days (${Math.round(rate * 100)}%).`,
        evidence: {
          sku: row.sku,
          totalReturned: row.totalReturned,
          totalOrdered: row.totalOrdered,
          returnRatePercentage: Math.round(rate * 10000) / 100,
          windowDays,
        },
        detectedAt,
      }));
  }
}
