import { logisticsDataSource } from '../adapters';
import { EvidenceCollector, HighReturnRateEvidence, PersistedException, RecentReturn } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class HighReturnRateEvidenceCollector implements EvidenceCollector {
  readonly exceptionType = ExceptionType.HIGH_RETURN_RATE;

  async collect(exception: PersistedException): Promise<Record<string, unknown> | null> {
    const built = await this.build(exception);
    return built as unknown as Record<string, unknown> | null;
  }

  private async build(exception: PersistedException): Promise<HighReturnRateEvidence | null> {
    const raw = exception.evidence;
    if (!raw) return null;

    const sku = raw.sku as string;
    const totalReturned = raw.totalReturned as number;
    const totalOrdered = raw.totalOrdered as number;
    const returnRatePercentage = raw.returnRatePercentage as number;
    const windowDays = raw.windowDays as number;
    // A rolling window anchored to "now" (evidence-fetch time), matching the original
    // query's DATE_SUB(NOW(), ...) — not fixed to when the exception was first detected.
    const returnedFrom = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const [product, recentReturnRows] = await Promise.all([
      logisticsDataSource.getProductBySku(sku),
      logisticsDataSource.getReturns({ sku, returnedFrom }),
    ]);

    const recentReturns: RecentReturn[] = recentReturnRows
      .slice()
      .sort((a, b) => (b.returnedAt?.getTime() ?? 0) - (a.returnedAt?.getTime() ?? 0))
      .map((row) => ({
        returnId: row.returnId,
        reason: row.reason,
        condition: row.condition,
        returnedAt: row.returnedAt,
      }));

    return {
      product: { sku, productName: product?.name ?? null, category: product?.category ?? null },
      totalReturned,
      totalOrdered,
      returnRatePercentage,
      windowDays,
      recentReturns,
    };
  }
}
