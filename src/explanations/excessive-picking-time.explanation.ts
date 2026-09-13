import { ExcessivePickingTimeEvidence, ExplanationGenerator, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class ExcessivePickingTimeExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKING_TIME;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { task, order, items } = evidence as unknown as ExcessivePickingTimeEvidence;

    const sentences = [
      `Task ${task.taskCode}, picked by ${task.pickerId}, took ${task.pickingMinutes} min — ${task.ratio.toFixed(1)}x the warehouse average of ${task.warehouseAverageMinutes.toFixed(1)} min.`,
    ];

    if (order) {
      sentences.push(
        `It belongs to order ${order.orderId} for customer ${order.customerId}${order.priority ? ` (priority ${order.priority})` : ''}.`,
      );
    }

    if (items.length > 0) {
      const list = items.map((item) => `${item.productName ?? item.sku} (${item.sku}) at ${item.location}`).join(', ');
      sentences.push(`The task covered ${items.length} line item(s): ${list}.`);
    }

    return sentences.join(' ');
  }
}
