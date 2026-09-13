import { Action, ActionSimulator, PersistedException, SimulationResult } from '../../interfaces';
import { exceptionRepository } from '../../repositories';
import { ActionType, ExceptionStatus, ExceptionType } from '../../types/enums';

interface RawOrderScopedEvidence {
  orderId?: string;
}

/**
 * PRIORITIZE_ORDER — SLA_AT_RISK, PACKING_DELAY, DISPATCH_DELAY, PICKING_DELAY. Projects the
 * effect of moving the entity to the front of its queue: the already-accrued wait is recovered.
 * PICKING_DELAY/PACKING_DELAY/DISPATCH_DELAY carry their own wait metric directly in the
 * exception's persisted evidence. SLA_AT_RISK carries none — it correlates the earliest OPEN
 * upstream delay for the same order (same correlation the SlaAtRiskAnalyzer itself uses, see
 * root-cause/sla-at-risk.analyzer.ts's PIPELINE_ORDER) and recovers that wait against the SLA clock.
 */
export class PrioritizeOrderSimulator implements ActionSimulator {
  readonly actionType = ActionType.PRIORITIZE_ORDER;

  async simulate(action: Action, exception: PersistedException): Promise<SimulationResult> {
    const params = action.parameters as { exceptionType: ExceptionType; entityId: string };

    if (params.exceptionType === ExceptionType.PICKING_DELAY) {
      const evidence = exception.evidence as { elapsedMinutes?: number } | null;
      return this.buildWaitResult(evidence?.elapsedMinutes ?? null, 'picking task queue wait');
    }

    if (params.exceptionType === ExceptionType.PACKING_DELAY || params.exceptionType === ExceptionType.DISPATCH_DELAY) {
      const evidence = exception.evidence as { minutesWaiting?: number } | null;
      return this.buildWaitResult(evidence?.minutesWaiting ?? null, `${params.exceptionType.toLowerCase()} queue wait`);
    }

    if (params.exceptionType === ExceptionType.SLA_AT_RISK) {
      return this.simulateSlaAtRisk(exception, params.entityId);
    }

    return {
      success: false,
      before: {},
      after: {},
      changes: {},
      notes: [`PRIORITIZE_ORDER is not simulatable for ${params.exceptionType}.`],
    };
  }

  private buildWaitResult(waitingMinutes: number | null, label: string): SimulationResult {
    if (waitingMinutes === null) {
      return { success: false, before: {}, after: {}, changes: {}, notes: [`No ${label} metric is available on this exception's evidence.`] };
    }
    return {
      success: true,
      before: { waitingMinutes },
      after: { waitingMinutes: 0 },
      changes: { waitingMinutes: { from: waitingMinutes, to: 0 } },
      notes: [`Moving to the front of the queue eliminates the ${label} already accrued (${waitingMinutes} min).`],
    };
  }

  private async simulateSlaAtRisk(exception: PersistedException, orderId: string): Promise<SimulationResult> {
    const evidence = exception.evidence as { minutesRemaining?: number } | null;
    const minutesRemaining = evidence?.minutesRemaining ?? null;
    if (minutesRemaining === null) {
      return { success: false, before: {}, after: {}, changes: {}, notes: ['No minutesRemaining metric is available on this SLA_AT_RISK exception.'] };
    }

    const upstreamWaitMinutes = await this.findUpstreamWaitMinutes(orderId);
    const before = { minutesRemaining, upstreamWaitingMinutes: upstreamWaitMinutes };
    const after = { minutesRemaining: minutesRemaining + upstreamWaitMinutes, upstreamWaitingMinutes: 0 };

    return {
      success: true,
      before,
      after,
      changes: { minutesRemaining: { from: minutesRemaining, to: after.minutesRemaining } },
      notes:
        upstreamWaitMinutes > 0
          ? [`Recovers the ${upstreamWaitMinutes} minute(s) already accrued in the earliest correlated upstream delay for order ${orderId}.`]
          : [`No correlated OPEN upstream delay exception was found for order ${orderId}; prioritizing has no measurable wait to recover yet.`],
    };
  }

  /** Mirrors SlaAtRiskAnalyzer's own pipeline-position correlation — earliest OPEN upstream delay wins. */
  private async findUpstreamWaitMinutes(orderId: string): Promise<number> {
    const [pickingDelays, packingDelays, dispatchDelays] = await Promise.all([
      exceptionRepository.findAllByType(ExceptionType.PICKING_DELAY),
      exceptionRepository.findAllByType(ExceptionType.PACKING_DELAY),
      exceptionRepository.findAllByType(ExceptionType.DISPATCH_DELAY),
    ]);

    const isOpen = (e: PersistedException): boolean => e.status === ExceptionStatus.OPEN || e.status === ExceptionStatus.ACKNOWLEDGED || e.status === ExceptionStatus.IN_PROGRESS;

    const picking = pickingDelays.find((e) => isOpen(e) && ((e.evidence ?? {}) as RawOrderScopedEvidence).orderId === orderId);
    if (picking) return ((picking.evidence ?? {}) as { elapsedMinutes?: number }).elapsedMinutes ?? 0;

    const packing = packingDelays.find((e) => isOpen(e) && e.entityId === orderId);
    if (packing) return ((packing.evidence ?? {}) as { minutesWaiting?: number }).minutesWaiting ?? 0;

    const dispatch = dispatchDelays.find((e) => isOpen(e) && e.entityId === orderId);
    if (dispatch) return ((dispatch.evidence ?? {}) as { minutesWaiting?: number }).minutesWaiting ?? 0;

    return 0;
  }
}
