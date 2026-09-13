import { Action, ActionSimulator, PersistedException, SimulationResult } from '../../interfaces';
import { ActionType } from '../../types/enums';

/**
 * ESCALATE_OPERATION — a notification, not an operational state change with a numeric metric
 * (see recommendation/shared.ts ACTION_TYPE_DEFAULTS.ESCALATE: "does not itself change any WMS
 * state"). The simulation records the escalation state transition itself; it deliberately
 * produces no quantitative before/after metric, since this schema has no supervisor-response-time
 * data to project one from — see impact-engine.ts, which reports this honestly rather than
 * fabricating a number.
 */
export class EscalateOperationSimulator implements ActionSimulator {
  readonly actionType = ActionType.ESCALATE_OPERATION;

  async simulate(_action: Action, exception: PersistedException): Promise<SimulationResult> {
    return Promise.resolve({
      success: true,
      before: { escalated: false },
      after: { escalated: true, escalatedTo: 'SUPERVISOR', exceptionId: exception.exceptionId },
      changes: { escalated: { from: false, to: true } },
      notes: [
        'Escalation is informational only — this schema has no supervisor-response-time data, so no quantitative operational impact is projected.',
      ],
    });
  }
}
