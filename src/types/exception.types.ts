import { ExceptionSeverity, ExceptionStatus } from './enums';

/** Row shape of the engine-owned `exceptions` table (dummyw_data.exceptions). */
export interface ExceptionRow {
  id: number;
  exception_id: string;
  exception_type: string; // ExceptionType enum value; column is a free-form varchar(100)
  entity_type: string; // EntityType enum value; column is a free-form varchar(50)
  entity_id: string;
  severity: ExceptionSeverity;
  status: ExceptionStatus;
  title: string;
  description: string | null;
  // mysql2 detects the column's JSON type flag and auto-parses it into an object on read,
  // but it's still a plain string as far as our own parameter binding on INSERT is concerned.
  evidence: Record<string, unknown> | string | null;
  detected_at: Date;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
