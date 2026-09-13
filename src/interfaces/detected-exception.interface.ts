import { EntityType, ExceptionSeverity, ExceptionType } from '../types/enums';

/**
 * Structured output every rule must return. Never a plain string — evidence must
 * stay machine-readable so later phases (root cause analysis, AI copilot) can consume it.
 */
export interface DetectedException {
  type: ExceptionType;
  severity: ExceptionSeverity;
  entityType: EntityType;
  entityId: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  detectedAt: Date;
}
