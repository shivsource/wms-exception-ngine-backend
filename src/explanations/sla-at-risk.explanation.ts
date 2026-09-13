import { ExplanationGenerator, PersistedException, SlaAtRiskEvidence } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class SlaAtRiskExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.SLA_AT_RISK;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { order, items } = evidence as unknown as SlaAtRiskEvidence;

    if (!order) {
      return 'No order context is available for this SLA exception.';
    }

    const timing = order.breached
      ? `breached its SLA ${Math.abs(order.minutesRemaining)} min ago`
      : `is due to dispatch in ${order.minutesRemaining} min`;
    const sentences = [
      `Order ${order.orderId} for customer ${order.customerId}${order.priority ? ` (priority ${order.priority})` : ''} ${timing}, and is currently ${order.status}.`,
    ];

    const incomplete = items.filter((item) => (item.packedQuantity ?? 0) < item.orderedQuantity);
    if (incomplete.length > 0) {
      const list = incomplete
        .map((item) => `${item.productName ?? item.sku} (${item.sku}): picked ${item.pickedQuantity ?? 0}/packed ${item.packedQuantity ?? 0} of ${item.orderedQuantity}`)
        .join(', ');
      sentences.push(`${incomplete.length} of ${items.length} line items are not yet fully packed: ${list}.`);
    } else if (items.length > 0) {
      sentences.push(`All ${items.length} line items are fully packed.`);
    }

    return sentences.join(' ');
  }
}
