import { randomUUID } from 'node:crypto';
import { Pool, ResultSetHeader } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { ActionImpact, ActionOutcome } from '../interfaces';
import { ActionOutcomeRow } from '../types/action.types';
import { OutcomeResult } from '../types/enums';

export interface CreateActionOutcomeInput {
  actionDbId: number;
  actionId: string;
  result: OutcomeResult;
  beforeMetrics: Record<string, unknown>;
  afterMetrics: Record<string, unknown>;
  expectedImpact: ActionImpact;
  actualImpact: ActionImpact;
  measuredAt: Date;
}

function parseJsonColumn<T>(value: Record<string, unknown> | string): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as unknown as T;
}

function mapRow(row: ActionOutcomeRow): ActionOutcome {
  return {
    id: row.id,
    outcomeId: row.outcome_id,
    actionDbId: row.action_id,
    actionId: row.action_business_id,
    result: row.result as OutcomeResult,
    beforeMetrics: parseJsonColumn(row.before_metrics),
    afterMetrics: parseJsonColumn(row.after_metrics),
    expectedImpact: parseJsonColumn<ActionImpact>(row.expected_impact),
    actualImpact: parseJsonColumn<ActionImpact>(row.actual_impact),
    measuredAt: row.measured_at,
    createdAt: row.created_at,
  };
}

export class ActionOutcomeRepository {
  constructor(private readonly db: Pool) {}

  /** Persists one immutable outcome snapshot. Append-only, like root_cause_analyses — a re-executed
   *  action adds a new outcome row rather than overwriting the previous measurement. */
  async create(input: CreateActionOutcomeInput): Promise<ActionOutcome> {
    const outcomeId = `OUT-${randomUUID()}`;
    const [result] = await this.db.query<ResultSetHeader>(
      `INSERT INTO action_outcomes
         (outcome_id, action_id, action_business_id, result, before_metrics, after_metrics,
          expected_impact, actual_impact, measured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outcomeId,
        input.actionDbId,
        input.actionId,
        input.result,
        JSON.stringify(input.beforeMetrics),
        JSON.stringify(input.afterMetrics),
        JSON.stringify(input.expectedImpact),
        JSON.stringify(input.actualImpact),
        input.measuredAt,
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) {
      throw new Error(`Failed to reload action outcome ${outcomeId} immediately after insert`);
    }
    return created;
  }

  async findById(id: number): Promise<ActionOutcome | null> {
    const [rows] = await this.db.query<SqlRow<ActionOutcomeRow>[]>(
      'SELECT * FROM action_outcomes WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Most recent outcome for an action, or null if it has never been executed-and-measured. */
  async findLatestByAction(actionDbId: number): Promise<ActionOutcome | null> {
    const [rows] = await this.db.query<SqlRow<ActionOutcomeRow>[]>(
      'SELECT * FROM action_outcomes WHERE action_id = ? ORDER BY measured_at DESC LIMIT 1',
      [actionDbId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}
