import { computeImpact } from '../actions/impact-engine';
import { isUnmappable, mapRecommendationToAction } from '../actions/action-mapper';
import { deriveOutcomeResult } from '../actions/outcome-engine';
import { actionSimulatorRegistry } from '../actions/simulator-registry';
import { Action, ActionOutcome } from '../interfaces';
import {
  actionOutcomeRepository,
  actionRepository,
  exceptionRepository,
} from '../repositories';
import { ActionStatus, ExceptionType } from '../types/enums';
import { AppError } from '../utils/AppError';
import { exceptionService } from './exception.service';

export interface ExecuteActionResult {
  action: Action;
  outcome: ActionOutcome;
  alreadyExecuted: boolean;
}

/**
 * Orchestrates the Action/Execution/Outcome/Impact layer. Mirrors ExceptionService's role for
 * the earlier layers: this class has no business logic of its own beyond wiring — mapping
 * lives in action-mapper.ts, simulation in src/actions/simulators/, impact math in
 * impact-engine.ts, outcome derivation in outcome-engine.ts.
 */
export class ActionService {
  /** Persists a fresh recommendation snapshot for the exception (reusing ExceptionService's
   *  existing recommendation pipeline — never re-deriving root cause/recommendation logic here),
   *  then translates it into a concrete Action. Throws 422 if the recommendation's action verb
   *  has no deterministic operational state this engine can safely simulate yet. */
  async createFromException(exceptionDbId: number): Promise<Action> {
    const exception = await exceptionRepository.findById(exceptionDbId);
    if (!exception) {
      throw AppError.notFound(`Exception ${exceptionDbId} not found`);
    }

    const persistedRecommendation = await exceptionService.createRecommendation(exceptionDbId);
    const mapping = mapRecommendationToAction(exception, persistedRecommendation.result);

    if (isUnmappable(mapping)) {
      throw new AppError(
        `No executable Action could be created for exception ${exception.exceptionId} ` +
          `(recommended action: ${persistedRecommendation.result.recommendation.actionType}). ${mapping.reason}`,
        422,
      );
    }

    return actionRepository.create({
      exceptionDbId: exception.id,
      exceptionId: exception.exceptionId,
      exceptionType: exception.type as ExceptionType,
      recommendationDbId: persistedRecommendation.id,
      recommendationId: persistedRecommendation.recommendationId,
      actionType: mapping.actionType,
      title: mapping.title,
      reason: mapping.reason,
      parameters: mapping.parameters,
    });
  }

  async getById(id: number): Promise<Action> {
    const action = await actionRepository.findById(id);
    if (!action) {
      throw AppError.notFound(`Action ${id} not found`);
    }
    return action;
  }

  async listByException(exceptionDbId: number): Promise<Action[]> {
    return actionRepository.findAllByException(exceptionDbId);
  }

  async approve(id: number): Promise<Action> {
    const action = await this.getById(id);
    if (action.status !== ActionStatus.PROPOSED) {
      throw new AppError(`Action ${id} cannot be approved from status ${action.status} (must be PROPOSED)`, 409);
    }
    const approved = await actionRepository.approve(id);
    if (!approved) {
      throw new AppError(`Failed to approve action ${id}`, 500);
    }
    return approved;
  }

  /** Idempotent: an already-EXECUTED action returns its existing outcome rather than re-simulating. */
  async execute(id: number): Promise<ExecuteActionResult> {
    const action = await this.getById(id);

    if (action.status === ActionStatus.EXECUTED) {
      const outcome = await actionOutcomeRepository.findLatestByAction(action.id);
      if (!outcome) {
        throw new AppError(`Action ${id} is marked EXECUTED but has no recorded outcome`, 500);
      }
      return { action, outcome, alreadyExecuted: true };
    }
    if (action.status === ActionStatus.EXECUTING) {
      throw new AppError(`Action ${id} is already executing`, 409);
    }
    if (action.status === ActionStatus.REJECTED || action.status === ActionStatus.CANCELLED) {
      throw new AppError(`Action ${id} cannot be executed from status ${action.status}`, 409);
    }

    const exception = await exceptionRepository.findById(action.exceptionDbId);
    if (!exception) {
      throw AppError.notFound(`Exception ${action.exceptionDbId} for action ${id} not found`);
    }

    const simulator = actionSimulatorRegistry.get(action.actionType);
    if (!simulator) {
      await actionRepository.markCompleted(id, ActionStatus.FAILED);
      throw new AppError(`No simulator registered for action type ${action.actionType}`, 500);
    }

    await actionRepository.markExecuting(id);
    const simulation = await simulator.simulate(action, exception);
    const impact = computeImpact(action, exception, simulation);
    const result = deriveOutcomeResult(impact, simulation.success);

    const executed = await actionRepository.markCompleted(id, simulation.success ? ActionStatus.EXECUTED : ActionStatus.FAILED);
    if (!executed) {
      throw new AppError(`Failed to finalize execution for action ${id}`, 500);
    }

    // In this simulation-only phase, actual and expected impact are derived from the same
    // SimulationResult (see ActionOutcome's doc comment) — a future real-execution phase would
    // populate actualImpact independently by re-measuring post-mutation WMS state.
    const outcome = await actionOutcomeRepository.create({
      actionDbId: action.id,
      actionId: action.actionId,
      result,
      beforeMetrics: simulation.before,
      afterMetrics: simulation.after,
      expectedImpact: impact,
      actualImpact: impact,
      measuredAt: new Date(),
    });

    return { action: executed, outcome, alreadyExecuted: false };
  }

  async getOutcome(id: number): Promise<ActionOutcome> {
    const action = await this.getById(id);
    const outcome = await actionOutcomeRepository.findLatestByAction(action.id);
    if (!outcome) {
      throw AppError.notFound(`Action ${id} has not been executed yet — no outcome available`);
    }
    return outcome;
  }
}

export const actionService = new ActionService();
