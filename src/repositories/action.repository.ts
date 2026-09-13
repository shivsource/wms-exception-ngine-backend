import { randomUUID } from 'node:crypto';
import { Pool, ResultSetHeader } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { Action } from '../interfaces';
import { ActionRow } from '../types/action.types';
import { ActionStatus, ActionType, ExceptionType } from '../types/enums';

export interface CreateActionInput {
  exceptionDbId: number;
  exceptionId: string;
  exceptionType: ExceptionType;
  recommendationDbId: number;
  recommendationId: string;
  actionType: ActionType;
  title: string;
  reason: string;
  parameters: Record<string, unknown>;
}

function mapRow(row: ActionRow): Action {
  return {
    id: row.id,
    actionId: row.action_id,
    exceptionDbId: row.exception_id,
    exceptionId: row.exception_business_id,
    exceptionType: row.exception_type as ExceptionType,
    recommendationDbId: row.recommendation_id,
    recommendationId: row.recommendation_business_id,
    actionType: row.action_type as ActionType,
    status: row.status as ActionStatus,
    title: row.title,
    reason: row.reason,
    parameters: (typeof row.parameters === 'string' ? JSON.parse(row.parameters) : row.parameters) as Record<string, unknown>,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    executedAt: row.executed_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export class ActionRepository {
  constructor(private readonly db: Pool) {}

  /** Persists one Action at status PROPOSED. Content (title/reason/parameters) is immutable after
   *  creation — only status and the lifecycle timestamps change, via approve()/markExecuting()/etc. */
  async create(input: CreateActionInput): Promise<Action> {
    const actionId = `ACT-${randomUUID()}`;
    const [result] = await this.db.query<ResultSetHeader>(
      `INSERT INTO actions
         (action_id, exception_id, exception_business_id, exception_type,
          recommendation_id, recommendation_business_id, action_type, status, title, reason, parameters)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?)`,
      [
        actionId,
        input.exceptionDbId,
        input.exceptionId,
        input.exceptionType,
        input.recommendationDbId,
        input.recommendationId,
        input.actionType,
        input.title,
        input.reason,
        JSON.stringify(input.parameters),
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) {
      throw new Error(`Failed to reload action ${actionId} immediately after insert`);
    }
    return created;
  }

  async findById(id: number): Promise<Action | null> {
    const [rows] = await this.db.query<SqlRow<ActionRow>[]>('SELECT * FROM actions WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByActionId(actionId: string): Promise<Action | null> {
    const [rows] = await this.db.query<SqlRow<ActionRow>[]>(
      'SELECT * FROM actions WHERE action_id = ? LIMIT 1',
      [actionId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Every action created for a given exception, most recent first. */
  async findAllByException(exceptionDbId: number): Promise<Action[]> {
    const [rows] = await this.db.query<SqlRow<ActionRow>[]>(
      'SELECT * FROM actions WHERE exception_id = ? ORDER BY created_at DESC',
      [exceptionDbId],
    );
    return rows.map(mapRow);
  }

  async setStatus(id: number, status: ActionStatus): Promise<Action | null> {
    await this.db.query('UPDATE actions SET status = ? WHERE id = ?', [status, id]);
    return this.findById(id);
  }

  async approve(id: number): Promise<Action | null> {
    await this.db.query(
      `UPDATE actions SET status = 'APPROVED', approved_at = NOW() WHERE id = ?`,
      [id],
    );
    return this.findById(id);
  }

  async reject(id: number): Promise<Action | null> {
    await this.db.query(`UPDATE actions SET status = 'REJECTED' WHERE id = ?`, [id]);
    return this.findById(id);
  }

  async markExecuting(id: number): Promise<Action | null> {
    await this.db.query(
      `UPDATE actions SET status = 'EXECUTING', executed_at = NOW() WHERE id = ?`,
      [id],
    );
    return this.findById(id);
  }

  async markCompleted(id: number, status: ActionStatus.EXECUTED | ActionStatus.FAILED): Promise<Action | null> {
    await this.db.query(
      `UPDATE actions SET status = ?, completed_at = NOW() WHERE id = ?`,
      [status, id],
    );
    return this.findById(id);
  }

  async cancel(id: number): Promise<Action | null> {
    await this.db.query(`UPDATE actions SET status = 'CANCELLED' WHERE id = ?`, [id]);
    return this.findById(id);
  }
}
