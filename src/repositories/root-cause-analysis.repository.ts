import { randomUUID } from 'node:crypto';
import { Pool, ResultSetHeader } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { RootCauseAnalysis } from '../interfaces';
import { RootCauseAnalysisRow } from '../types/root-cause.types';

const ANALYZER_VERSION = 'v1';

/** A persisted snapshot of a RootCauseAnalysis — one row per POST /exceptions/:id/root-cause call. */
export interface PersistedRootCauseAnalysis {
  id: number;
  analysisId: string;
  exceptionDbId: number;
  exceptionType: string;
  analyzerVersion: string;
  result: RootCauseAnalysis;
  analyzedAt: Date;
  createdAt: Date;
}

function mapRow(row: RootCauseAnalysisRow): PersistedRootCauseAnalysis {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    exceptionDbId: row.exception_id,
    exceptionType: row.exception_type,
    analyzerVersion: row.analyzer_version,
    result: (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as unknown as RootCauseAnalysis,
    analyzedAt: row.analyzed_at,
    createdAt: row.created_at,
  };
}

export class RootCauseAnalysisRepository {
  constructor(private readonly db: Pool) {}

  /** Persists one immutable snapshot of an analysis. Analyses are append-only — re-analyzing
   *  the same exception later adds a new row rather than overwriting this one. */
  async create(exceptionDbId: number, analysis: RootCauseAnalysis): Promise<PersistedRootCauseAnalysis> {
    const analysisId = `RCA-${randomUUID()}`;
    const [result] = await this.db.query<ResultSetHeader>(
      `INSERT INTO root_cause_analyses
         (analysis_id, exception_id, exception_type, analyzer_version,
          primary_cause_type, primary_cause_score, primary_cause_confidence, result, analyzed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        analysisId,
        exceptionDbId,
        analysis.exceptionType,
        ANALYZER_VERSION,
        analysis.primaryCause?.type ?? null,
        analysis.primaryCause?.score ?? null,
        analysis.primaryCause?.confidenceLevel ?? null,
        JSON.stringify(analysis),
        analysis.analyzedAt,
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) {
      throw new Error(`Failed to reload root cause analysis ${analysisId} immediately after insert`);
    }
    return created;
  }

  async findById(id: number): Promise<PersistedRootCauseAnalysis | null> {
    const [rows] = await this.db.query<SqlRow<RootCauseAnalysisRow>[]>(
      'SELECT * FROM root_cause_analyses WHERE id = ? LIMIT 1',
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Most recent snapshot for an exception, or null if it has never been analyzed-and-persisted. */
  async findLatestByException(exceptionDbId: number): Promise<PersistedRootCauseAnalysis | null> {
    const [rows] = await this.db.query<SqlRow<RootCauseAnalysisRow>[]>(
      'SELECT * FROM root_cause_analyses WHERE exception_id = ? ORDER BY analyzed_at DESC LIMIT 1',
      [exceptionDbId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}
