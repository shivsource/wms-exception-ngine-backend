import { PersistedException, RecommendationResult } from '../interfaces';
import { ActionType, ExceptionType } from '../types/enums';

/** Structured translation of a recommendation's chosen action into a concrete, simulatable Action. */
export interface ActionMapping {
  actionType: ActionType;
  title: string;
  reason: string;
  parameters: Record<string, unknown>;
}

/** Returned instead of an ActionMapping when the recommendation's action verb has no deterministic
 *  operational state this engine can safely simulate for this exception — see each case below for why. */
export interface UnmappableRecommendation {
  unmappable: true;
  reason: string;
}

function unmappable(reason: string): UnmappableRecommendation {
  return { unmappable: true, reason };
}

/**
 * Translates a RecommendationResult (generic verb + target cause) into a concrete ActionType
 * (src/types/enums.ts) with structured parameters a Simulator can act on. Every branch either
 * returns a mapping backed by a real Simulator (src/actions/simulators/) or explains, in
 * `reason`, exactly why no Action can be safely created yet — never silently drops information.
 *
 * `recommendation.rootCause` reflects the analysis's PRIMARY cause; RecommendedAction does not
 * expose which specific cause the *chosen* action targets. In practice the top-ranked action is
 * the one the scoring rubric rewards for matching the primary cause (see
 * recommendation/shared.ts#scoreCandidateAction), so using the primary cause as a proxy for "the
 * cause this action addresses" is accurate for the #1 recommendation in the common case — a
 * documented limitation, not a silent guess.
 */
export function mapRecommendationToAction(
  exception: PersistedException,
  recommendation: RecommendationResult,
): ActionMapping | UnmappableRecommendation {
  const action = recommendation.recommendation;
  const causeType = recommendation.rootCause?.type ?? null;

  switch (action.actionType) {
    case 'REASSIGN': {
      if (exception.type === ExceptionType.PICKING_DELAY) {
        // The picking task is still IN_PROGRESS (that's what makes it PICKING_DELAY) — a real,
        // in-flight target to reassign.
        return causeType === 'INVENTORY_SHORTAGE'
          ? {
              actionType: ActionType.MOVE_INVENTORY,
              title: action.title,
              reason: action.reason,
              parameters: { taskId: exception.entityId },
            }
          : {
              actionType: ActionType.REASSIGN_PICKER,
              title: action.title,
              reason: action.reason,
              parameters: { taskId: exception.entityId },
            };
      }
      if (exception.type === ExceptionType.EXCESSIVE_PICKER_DISTANCE || exception.type === ExceptionType.EXCESSIVE_PICKING_TIME) {
        return unmappable(
          `${exception.type} only fires on an already-COMPLETED task — the recommended reassignment is about the ` +
            'picker\'s future task queue, not this already-finished task, so there is no in-flight operational state to simulate.',
        );
      }
      // SLA_AT_RISK's REASSIGN (upstream EXCESSIVE_PICKER_DISTANCE/TIME) references the order,
      // not a specific picking task — SLA_AT_RISK exceptions carry no task id to reassign.
      return unmappable(
        `REASSIGN on ${exception.type} references the order, not a specific picking task — there is no task id to reassign a picker on.`,
      );
    }

    case 'REPLENISH': {
      if (exception.type !== ExceptionType.INVENTORY_SHORTAGE) {
        return unmappable(
          `REPLENISH is only simulatable for INVENTORY_SHORTAGE (SKU-scoped, with a known reorder level target) — ${exception.type} has no SKU-scoped replenishment target.`,
        );
      }
      return {
        actionType: ActionType.REPLENISH_INVENTORY,
        title: action.title,
        reason: action.reason,
        parameters: { sku: exception.entityId },
      };
    }

    case 'PRIORITIZE': {
      return {
        actionType: ActionType.PRIORITIZE_ORDER,
        title: action.title,
        reason: action.reason,
        parameters: { exceptionType: exception.type, entityType: exception.entityType, entityId: exception.entityId },
      };
    }

    case 'VERIFY':
    case 'CHECK_INVENTORY': {
      if (exception.type === ExceptionType.INVENTORY_DISCREPANCY) {
        const [sku, location] = exception.entityId.split(':');
        return {
          actionType: ActionType.RECHECK_INVENTORY,
          title: action.title,
          reason: action.reason,
          parameters: { sku, location },
        };
      }
      return unmappable(
        `${action.actionType} outside INVENTORY_DISCREPANCY is a read-only records check — there is no deterministic operational state change to simulate.`,
      );
    }

    case 'ESCALATE': {
      return {
        actionType: ActionType.ESCALATE_OPERATION,
        title: action.title,
        reason: action.reason,
        parameters: { exceptionType: exception.type, entityType: exception.entityType, entityId: exception.entityId },
      };
    }

    case 'CHECK_LOCATION':
      return unmappable('CHECK_LOCATION is a physical warehouse check with no corresponding WMS data field to simulate.');

    case 'RE_PICK':
      return unmappable('Re-pick duration is not modeled per line item in current evidence; the completion-time effect cannot be simulated deterministically.');

    case 'RE_PACK':
      return unmappable('Re-pack duration is not modeled in current evidence; the completion-time effect cannot be simulated deterministically.');

    case 'ADJUST':
      return unmappable(
        'ADJUST carries HIGH risk / REQUIRED approval — correcting reservation data needs a human-determined target value this engine cannot safely infer.',
      );

    case 'INVESTIGATE':
      return unmappable('INVESTIGATE is a qualitative review step with no operational state to simulate.');

    case 'MONITOR':
      return unmappable('MONITOR is a passive wait-and-observe recommendation, not an operational intervention — no Action is created.');

    default:
      return unmappable(`Unrecognized recommendation action type: ${action.actionType as string}`);
  }
}

export function isUnmappable(result: ActionMapping | UnmappableRecommendation): result is UnmappableRecommendation {
  return (result as UnmappableRecommendation).unmappable === true;
}
