import { randomUUID } from 'node:crypto';
import { Pool, ResultSetHeader } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { RecommendationResult } from '../interfaces';
import { ExceptionRecommendationRow } from '../types/recommendation.types';

/** A persisted snapshot of a RecommendationResult — one row per POST /exceptions/:id/recommendation call. */
export interface PersistedExceptionRecommendation {
  id: number;
  recommendationId: string;
  exceptionDbId: number;
  exceptionType: string;
  actionType: string;
  title: string;
  priority: string;
  riskLevel: string;
  approvalLevel: string;
  confidenceLevel: string;
  score: number;
  status: string;
  result: RecommendationResult;
  analyzedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

function mapRow(row: ExceptionRecommendationRow): PersistedExceptionRecommendation {
  return {
    id: row.id,
    recommendationId: row.recommendation_id,
    exceptionDbId: row.exception_id,
    exceptionType: row.exception_type,
    actionType: row.action_type,
    title: row.title,
    priority: row.priority,
    riskLevel: row.risk_level,
    approvalLevel: row.approval_level,
    confidenceLevel: row.confidence_level,
    score: row.score,
    status: row.status,
    result: (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as unknown as RecommendationResult,
    analyzedAt: row.analyzed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExceptionRecommendationRepository {
  constructor(private readonly db: Pool) {}

  /** Persists one immutable snapshot at status PENDING. Recommendations are append-only content —
   *  only `status` is ever expected to change later, by a human decision (out of scope here). */
  async create(exceptionDbId: number, recommendation: RecommendationResult): Promise<PersistedExceptionRecommendation> {
    const recommendationId = `REC-${randomUUID()}`;
    const action = recommendation.recommendation;
    const [result] = await this.db.query<ResultSetHeader>(
      `INSERT INTO exception_recommendations
         (recommendation_id, exception_id, exception_type, action_type, title, priority,
          risk_level, approval_level, confidence_level, score, result, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recommendationId,
        exceptionDbId,
        recommendation.exceptionType,
        action.actionType,
        action.title,
        action.priority,
        action.risk.level,
        action.approval.level,
        action.confidenceLevel,
        action.score,
        JSON.stringify(recommendation),
        recommendation.analyzedAt,
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) {
      throw new Error(`Failed to reload recommendation ${recommendationId} immediately after insert`);
    }
    return created;
  }

  async findById(id: number): Promise<PersistedExceptionRecommendation | null> {
    const [rows] = await this.db.query<SqlRow<ExceptionRecommendationRow>[]>(
      'SELECT * FROM exception_recommendations WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Most recent snapshot for an exception, or null if it has never been recommended-and-persisted. */
  async findLatestByException(exceptionDbId: number): Promise<PersistedExceptionRecommendation | null> {
    const [rows] = await this.db.query<SqlRow<ExceptionRecommendationRow>[]>(
      'SELECT * FROM exception_recommendations WHERE exception_id = ? ORDER BY analyzed_at DESC LIMIT 1',
      [exceptionDbId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}
