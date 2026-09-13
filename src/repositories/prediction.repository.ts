import { randomUUID } from 'node:crypto';
import { Pool, ResultSetHeader } from 'mysql2/promise';
import { SqlRow } from '../database/types';
import { PersistedPrediction, PredictionEvaluationResult, RiskSignal } from '../interfaces';
import { PredictionRow } from '../types/prediction.types';
import { EntityType, PredictionStatus, PredictionType, RiskLevel } from '../types/enums';

export interface PredictionFilters {
  status?: PredictionStatus | undefined;
  riskLevel?: RiskLevel | undefined;
  predictionType?: PredictionType | undefined;
  entityType?: EntityType | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function mapRow(row: PredictionRow): PersistedPrediction {
  return {
    id: row.id,
    predictionId: row.prediction_id,
    predictionType: row.prediction_type as PredictionType,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id,
    riskScore: row.risk_score,
    riskLevel: row.risk_level as RiskLevel,
    confidence: row.confidence as PersistedPrediction['confidence'],
    status: row.status as PredictionStatus,
    predictionWindow: row.prediction_window_minutes !== null ? { value: row.prediction_window_minutes, unit: 'MINUTES' } : null,
    signals: parseJsonColumn<RiskSignal[]>(row.signals, []),
    explanation: row.explanation,
    limitations: parseJsonColumn<string[]>(row.limitations, []),
    confirmedExceptionId: row.confirmed_exception_id,
    predictedAt: row.predicted_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PredictionRepository {
  constructor(private readonly db: Pool) {}

  /** Whether an ACTIVE or CONFIRMED prediction of this type already exists for this entity —
   *  used by the engine to update in place instead of inserting a duplicate on every run
   *  (mirrors ExceptionRepository.findExistingOpen's role for idempotency). */
  async findActiveOrConfirmed(predictionType: PredictionType, entityType: EntityType, entityId: string): Promise<PersistedPrediction | null> {
    const [rows] = await this.db.query<SqlRow<PredictionRow>[]>(
      `SELECT * FROM predictions
       WHERE prediction_type = ? AND entity_type = ? AND entity_id = ? AND status IN ('ACTIVE', 'CONFIRMED')
       LIMIT 1`,
      [predictionType, entityType, entityId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(evaluation: PredictionEvaluationResult, status: PredictionStatus, confirmedExceptionId: string | null): Promise<PersistedPrediction> {
    const predictionId = `PRED-${randomUUID()}`;
    const [result] = await this.db.query<ResultSetHeader>(
      `INSERT INTO predictions
         (prediction_id, prediction_type, entity_type, entity_id, risk_score, risk_level, confidence,
          status, prediction_window_minutes, signals, explanation, limitations, confirmed_exception_id, predicted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        predictionId,
        evaluation.predictionType,
        evaluation.entityType,
        evaluation.entityId,
        evaluation.riskScore,
        evaluation.riskLevel,
        evaluation.confidence,
        status,
        evaluation.predictionWindow?.value ?? null,
        JSON.stringify(evaluation.signals),
        evaluation.explanation,
        JSON.stringify(evaluation.limitations),
        confirmedExceptionId,
        evaluation.evaluatedAt,
      ],
    );
    const created = await this.findById(result.insertId);
    if (!created) {
      throw new Error(`Failed to reload prediction ${predictionId} immediately after insert`);
    }
    return created;
  }

  /** Updates an existing ACTIVE/CONFIRMED prediction in place with a fresh evaluation —
   *  the idempotent counterpart to create(), used when findActiveOrConfirmed finds a row. */
  async update(id: number, evaluation: PredictionEvaluationResult, status: PredictionStatus, confirmedExceptionId: string | null): Promise<PersistedPrediction> {
    await this.db.query(
      `UPDATE predictions
       SET risk_score = ?, risk_level = ?, confidence = ?, status = ?, prediction_window_minutes = ?,
           signals = ?, explanation = ?, limitations = ?, confirmed_exception_id = ?, predicted_at = ?
       WHERE id = ?`,
      [
        evaluation.riskScore,
        evaluation.riskLevel,
        evaluation.confidence,
        status,
        evaluation.predictionWindow?.value ?? null,
        JSON.stringify(evaluation.signals),
        evaluation.explanation,
        JSON.stringify(evaluation.limitations),
        confirmedExceptionId,
        evaluation.evaluatedAt,
        id,
      ],
    );
    const updated = await this.findById(id);
    if (!updated) {
      throw new Error(`Failed to reload prediction ${id} immediately after update`);
    }
    return updated;
  }

  async resolve(id: number): Promise<PersistedPrediction | null> {
    await this.db.query(`UPDATE predictions SET status = 'RESOLVED', resolved_at = NOW() WHERE id = ?`, [id]);
    return this.findById(id);
  }

  async findById(id: number): Promise<PersistedPrediction | null> {
    const [rows] = await this.db.query<SqlRow<PredictionRow>[]>('SELECT * FROM predictions WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findAll(filters: PredictionFilters = {}): Promise<PersistedPrediction[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.riskLevel) {
      conditions.push('risk_level = ?');
      params.push(filters.riskLevel);
    }
    if (filters.predictionType) {
      conditions.push('prediction_type = ?');
      params.push(filters.predictionType);
    }
    if (filters.entityType) {
      conditions.push('entity_type = ?');
      params.push(filters.entityType);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const [rows] = await this.db.query<SqlRow<PredictionRow>[]>(
      `SELECT * FROM predictions ${whereClause} ORDER BY predicted_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(mapRow);
  }

  async findByEntityId(entityId: string): Promise<PersistedPrediction[]> {
    const [rows] = await this.db.query<SqlRow<PredictionRow>[]>(
      'SELECT * FROM predictions WHERE entity_id = ? ORDER BY predicted_at DESC',
      [entityId],
    );
    return rows.map(mapRow);
  }

  /** Every currently ACTIVE/CONFIRMED prediction of a type — used by the engine after a bulk
   *  run to resolve any prediction whose entity no longer appears among this run's candidates. */
  async findActiveOrConfirmedByType(predictionType: PredictionType): Promise<PersistedPrediction[]> {
    const [rows] = await this.db.query<SqlRow<PredictionRow>[]>(
      `SELECT * FROM predictions WHERE prediction_type = ? AND status IN ('ACTIVE', 'CONFIRMED')`,
      [predictionType],
    );
    return rows.map(mapRow);
  }
}
