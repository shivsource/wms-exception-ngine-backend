import { ExplanationGenerator, InventoryShortageEvidence, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class InventoryShortageExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.INVENTORY_SHORTAGE;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { product, totals, locations } = evidence as unknown as InventoryShortageEvidence;

    const sentences = [
      `${product.productName ?? product.sku} (${product.sku}) has ${totals.totalAvailable} units available against a reorder level of ${product.reorderLevel ?? 'n/a'} — a shortfall of ${totals.shortfallUnits} units (${totals.shortfallPercentage}%).`,
    ];

    if (locations.length > 0) {
      const list = locations
        .map((loc) => `${loc.location}: ${loc.quantity} on hand, ${loc.reservedQuantity} reserved, ${loc.damagedQuantity} damaged`)
        .join('; ');
      sentences.push(`Stock is spread across ${locations.length} location(s): ${list}.`);
    }

    return sentences.join(' ');
  }
}
