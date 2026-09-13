import { ExplanationGenerator, InventoryDiscrepancyEvidence, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class InventoryDiscrepancyExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.INVENTORY_DISCREPANCY;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { product, discrepancy, locations } = evidence as unknown as InventoryDiscrepancyEvidence;

    const mismatches: string[] = [];
    if (discrepancy.reservedQuantity > discrepancy.quantity) {
      mismatches.push(`reserved quantity (${discrepancy.reservedQuantity}) exceeds physical quantity (${discrepancy.quantity})`);
    }
    if (discrepancy.damagedQuantity > discrepancy.quantity) {
      mismatches.push(`damaged quantity (${discrepancy.damagedQuantity}) exceeds physical quantity (${discrepancy.quantity})`);
    }

    const sentences = [
      `${product.productName ?? product.sku} (${product.sku}) at location ${discrepancy.location} has a data mismatch: ${mismatches.join(' and ')}.`,
    ];

    if (locations.length > 1) {
      sentences.push(`This SKU is stocked across ${locations.length} location(s) in total.`);
    }

    return sentences.join(' ');
  }
}
