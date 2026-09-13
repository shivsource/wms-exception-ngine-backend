import { randomUUID } from 'node:crypto';
import { Pool, ResultSetHeader } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { DetectedException, PersistedException } from '../interfaces';
import { ExceptionRow } from '../types/exception.types';
import { EntityType, ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

export interface ExceptionFilters {
  status?: ExceptionStatus | undefined;
  severity?: ExceptionSeverity | undefined;
  type?: ExceptionType | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function mapRow(row: ExceptionRow): PersistedException {
  return {
    id: row.id,
    exceptionId: row.exception_id,
    type: row.exception_type as ExceptionType,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    evidence: row.evidence
      ? typeof row.evidence === 'string'
        ? (JSON.parse(row.evidence) as Record<string, unknown>)
        : row.evidence
      : null,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExceptionRepository {
  constructor(private readonly db: Pool) {}

  /** Whether an OPEN exception of this type already exists for this entity — used by the engine to avoid duplicate inserts on every scheduler run. */
  async findExistingOpen(
    type: ExceptionType,
    entityType: EntityType,
    entityId: string,
  ): Promise<PersistedException | null> {
    const [rows] = await this.db.query<SqlRow<ExceptionRow>[]>(
      `SELECT * FROM exceptions
       WHERE exception_type = ? AND entity_type = ? AND entity_id = ? AND status = 'OPEN'
       LIMIT 1`,
      [type, entityType, entityId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(exception: DetectedException): Promise<PersistedException> {
    const exceptionId = `EXC-${randomUUID()}`;
    const [result] = await this.db.query<ResultSetHeader>(
      `INSERT INTO exceptions
         (exception_id, exception_type, entity_type, entity_id, severity, status, title, description, evidence, detected_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      [
        exceptionId,
        exception.type,
        exception.entityType,
        exception.entityId,
        exception.severity,
        exception.title,
        exception.description,
        JSON.stringify(exception.evidence),
        exception.detectedAt,
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) {
      throw new Error(`Failed to reload exception ${exceptionId} immediately after insert`);
    }
    return created;
  }

  async findById(id: number): Promise<PersistedException | null> {
    const [rows] = await this.db.query<SqlRow<ExceptionRow>[]>(
      'SELECT * FROM exceptions WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findAll(filters: ExceptionFilters = {}): Promise<PersistedException[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.severity) {
      conditions.push('severity = ?');
      params.push(filters.severity);
    }
    if (filters.type) {
      conditions.push('exception_type = ?');
      params.push(filters.type);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const [rows] = await this.db.query<SqlRow<ExceptionRow>[]>(
      `SELECT * FROM exceptions ${whereClause} ORDER BY detected_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(mapRow);
  }

  async findOpen(): Promise<PersistedException[]> {
    return this.findAll({ status: ExceptionStatus.OPEN, limit: 500 });
  }

  /** Every currently-OPEN exception for one specific entity — unlike findOpen(), not capped
   *  at 500 rows, so it stays correct regardless of how many other exceptions are open
   *  warehouse-wide. Used by the Prediction Engine's single-entity evaluation to show
   *  "what's already open for this entity" without relying on a bulk, ordering-dependent fetch. */
  async findOpenByEntity(entityType: EntityType, entityId: string): Promise<PersistedException[]> {
    const [rows] = await this.db.query<SqlRow<ExceptionRow>[]>(
      `SELECT * FROM exceptions WHERE entity_type = ? AND entity_id = ? AND status = 'OPEN' ORDER BY detected_at DESC`,
      [entityType, entityId],
    );
    return rows.map(mapRow);
  }

  /** Currently-active critical exceptions (excludes ones already resolved or ignored). */
  async findCritical(): Promise<PersistedException[]> {
    const [rows] = await this.db.query<SqlRow<ExceptionRow>[]>(
      `SELECT * FROM exceptions
       WHERE severity = 'CRITICAL' AND status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS')
       ORDER BY detected_at DESC`,
    );
    return rows.map(mapRow);
  }

  /**
   * Every exception of a given type, most recently detected first — used by the root
   * cause engine to correlate sibling exceptions (same task/SKU) in-memory rather than
   * building dynamic per-candidate SQL for each correlation shape it needs.
   */
  async findAllByType(type: ExceptionType): Promise<PersistedException[]> {
    const [rows] = await this.db.query<SqlRow<ExceptionRow>[]>(
      `SELECT * FROM exceptions WHERE exception_type = ? ORDER BY detected_at DESC`,
      [type],
    );
    return rows.map(mapRow);
  }

  async resolve(id: number): Promise<PersistedException | null> {
    await this.db.query(
      `UPDATE exceptions SET status = 'RESOLVED', resolved_at = NOW() WHERE id = ?`,
      [id],
    );
    return this.findById(id);
  }
}
