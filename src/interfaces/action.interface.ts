import { ActionStatus, ActionType, ExceptionType } from '../types/enums';

/**
 * Domain shape returned by ActionRepository — the structured operational intervention
 * translated from a RecommendationResult (see src/actions/action-mapper.ts). Answers
 * "WHAT SPECIFIC OPERATIONAL CHANGE SHOULD BE MADE?" — distinct from the Recommendation
 * it was created from (which only answers "what should the operator do?" in general terms)
 * and distinct from its Execution/Outcome (which answer whether it happened and whether it
 * worked). See ARCHITECTURE.md for the full chain.
 */
export interface Action {
  id: number;
  actionId: string;
  exceptionDbId: number;
  exceptionId: string;
  exceptionType: ExceptionType;
  recommendationDbId: number;
  recommendationId: string;
  actionType: ActionType;
  status: ActionStatus;
  title: string;
  reason: string;
  /** Structured inputs the simulator needs (e.g. { taskId, fromPickerId } for REASSIGN_PICKER) — shape is actionType-specific, see each simulator. */
  parameters: Record<string, unknown>;
  createdAt: Date;
  approvedAt: Date | null;
  executedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}
