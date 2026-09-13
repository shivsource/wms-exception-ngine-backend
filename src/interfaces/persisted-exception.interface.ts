import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

/** Domain shape returned by ExceptionRepository — the DB row translated out of raw strings/JSON text. */
export interface PersistedException {
  id: number;
  exceptionId: string;
  type: ExceptionType;
  entityType: EntityType;
  entityId: string;
  severity: ExceptionSeverity;
  status: ExceptionStatus;
  title: string;
  description: string | null;
  evidence: Record<string, unknown> | null;
  detectedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
