import { ExplanationGenerator, PersistedException, PickingErrorEvidence } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class PickingErrorExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.PICKING_ERROR;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { task, order, errorCount, errors } = evidence as unknown as PickingErrorEvidence;

    const sentences = [
      `Task ${task.taskCode}, assigned to picker ${task.pickerId}${task.status ? ` (status ${task.status})` : ''}, recorded ${errorCount} picking error(s).`,
    ];

    if (order) {
      sentences.push(
        `It belongs to order ${order.orderId} for customer ${order.customerId}${order.priority ? ` (priority ${order.priority})` : ''}.`,
      );
    }

    if (errors.length > 0) {
      const list = errors
        .map(
          (item) =>
            `${item.productName ?? item.sku} (${item.sku}) at ${item.location} — requested ${item.requestedQuantity}, picked ${item.pickedQuantity ?? 0}, reason: ${item.errorReason}`,
        )
        .join('; ');
      sentences.push(`Errors: ${list}.`);
    }

    return sentences.join(' ');
  }
}
