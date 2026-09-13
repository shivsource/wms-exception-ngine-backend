import { ExplanationGenerator, PersistedException, PickingDelayEvidence } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class PickingDelayExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.PICKING_DELAY;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { task, order, items, baseline } = evidence as unknown as PickingDelayEvidence;

    const ratioText =
      baseline.delayRatio !== null
        ? `${baseline.delayRatio.toFixed(1)}x the warehouse average of ${Math.round(baseline.avgCompletedMinutes)} min`
        : 'above the warehouse average (no baseline available)';
    const sentences = [
      `Task ${task.taskCode}, assigned to picker ${task.pickerId}, has been in progress for ${task.elapsedMinutes} min — ${ratioText}.`,
    ];

    if (order) {
      sentences.push(
        `It belongs to order ${order.orderId} for customer ${order.customerId}` +
          `${order.priority ? ` (priority ${order.priority})` : ''}, expected to dispatch by ${order.expectedDispatch.toISOString()}.`,
      );
    }

    const pending = items.filter((item) => item.pending > 0);
    if (pending.length > 0) {
      const list = pending
        .map((item) => `${item.pending}x ${item.productName ?? item.sku} (${item.sku}) at ${item.location}`)
        .join(', ');
      sentences.push(`${pending.length} of ${items.length} line items are still pending: ${list}.`);
    } else if (items.length > 0) {
      sentences.push(`All ${items.length} line items are marked picked, but the task has not been closed out.`);
    }

    return sentences.join(' ');
  }
}
