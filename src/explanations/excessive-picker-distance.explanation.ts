import { ExcessivePickerDistanceEvidence, ExplanationGenerator, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class ExcessivePickerDistanceExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.EXCESSIVE_PICKER_DISTANCE;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { task, order, items } = evidence as unknown as ExcessivePickerDistanceEvidence;

    const sentences = [
      `Task ${task.taskCode}, picked by ${task.pickerId}, covered ${task.distanceWalked}m — ${task.ratio.toFixed(1)}x the warehouse average of ${task.warehouseAverageDistance.toFixed(1)}m.`,
    ];

    if (order) {
      sentences.push(
        `It belongs to order ${order.orderId} for customer ${order.customerId}${order.priority ? ` (priority ${order.priority})` : ''}.`,
      );
    }

    if (items.length > 0) {
      const locations = [...new Set(items.map((item) => item.location))];
      sentences.push(`The task visited ${locations.length} location(s) across ${items.length} line item(s): ${locations.join(', ')}.`);
    }

    return sentences.join(' ');
  }
}
