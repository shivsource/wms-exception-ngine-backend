import { ExplanationGenerator, PackingDelayEvidence, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class PackingDelayExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.PACKING_DELAY;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { order, lastPickingCompletedAt, minutesWaiting, items } = evidence as unknown as PackingDelayEvidence;

    const sentences = [
      `Picking finished at ${lastPickingCompletedAt.toISOString()} (${minutesWaiting} min ago) but no packing record exists yet.`,
    ];

    if (order) {
      sentences.push(
        `Order ${order.orderId} for customer ${order.customerId}${order.priority ? ` (priority ${order.priority})` : ''} is expected to dispatch by ${order.expectedDispatch.toISOString()}.`,
      );
    }

    if (items.length > 0) {
      const list = items.map((item) => `${item.productName ?? item.sku} (${item.sku}) x${item.orderedQuantity}`).join(', ');
      sentences.push(`Awaiting packing: ${list}.`);
    }

    return sentences.join(' ');
  }
}
