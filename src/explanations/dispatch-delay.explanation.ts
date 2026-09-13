import { DispatchDelayEvidence, ExplanationGenerator, PersistedException } from '../interfaces';
import { ExceptionType } from '../types/enums';

export class DispatchDelayExplanationGenerator implements ExplanationGenerator {
  readonly exceptionType = ExceptionType.DISPATCH_DELAY;

  explain(_exception: PersistedException, evidence: Record<string, unknown>): string {
    const { order, packing, minutesWaiting } = evidence as unknown as DispatchDelayEvidence;

    const sentences = [`The order was packed ${minutesWaiting} min ago and has not yet departed.`];

    if (order) {
      sentences.push(
        `Order ${order.orderId} for customer ${order.customerId}${order.priority ? ` (priority ${order.priority})` : ''} was expected to dispatch by ${order.expectedDispatch.toISOString()}.`,
      );
    }

    if (packing) {
      sentences.push(
        `Packed by ${packing.packedBy} at ${packing.packingTime.toISOString()}` +
          `${packing.packageSize ? `, package size ${packing.packageSize}` : ''}` +
          `${packing.weight !== null ? `, weight ${packing.weight}` : ''}` +
          `${packing.damaged ? ', flagged as damaged' : ''}.`,
      );
    }

    return sentences.join(' ');
  }
}
