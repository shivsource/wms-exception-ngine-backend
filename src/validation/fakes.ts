import { DetectedException, PersistedException, PersistedPrediction, PredictionEvaluationResult } from '../interfaces';
import { EntityType, ExceptionStatus, ExceptionType, PredictionStatus, PredictionType } from '../types/enums';

/**
 * In-memory stand-ins for ExceptionRepository / PredictionRepository, implementing exactly
 * the methods ExceptionEngine / PredictionEngine call (see src/engine/*.ts) — nothing more.
 *
 * This is the SAME safety mechanism the repository already uses for offline testing (see
 * src/canonical/mock-pipeline.test.ts and src/predictors/prediction-scenarios.test.ts, both
 * of which `vi.mock('../repositories', ...)` for exactly this reason): the real repositories
 * (src/repositories/exception.repository.ts, prediction.repository.ts) open a live MySQL pool
 * on import and would write directly into the production `exceptions`/`predictions` tables.
 * The validation framework must never do that (Section 20 — database safety) — these fakes
 * are the "already used by the project" safe mechanism, reused rather than reinvented.
 */

let exceptionIdCounter = 0;
let predictionIdCounter = 0;

export class FakeExceptionRepository {
  private rows: PersistedException[] = [];

  reset(): void {
    this.rows = [];
    exceptionIdCounter = 0;
  }

  /** Pre-seeds an already-OPEN exception before any engine run — used only by the
   *  CONFIRMED_BEFORE_PREDICTION scenario (Section 25). */
  seedExisting(exception: Omit<PersistedException, 'id' | 'exceptionId' | 'status' | 'createdAt' | 'updatedAt' | 'resolvedAt'>): PersistedException {
    exceptionIdCounter += 1;
    const row: PersistedException = {
      id: exceptionIdCounter,
      exceptionId: `EXC-VAL-${exceptionIdCounter}`,
      status: ExceptionStatus.OPEN,
      createdAt: exception.detectedAt,
      updatedAt: exception.detectedAt,
      resolvedAt: null,
      ...exception,
    };
    this.rows.push(row);
    return row;
  }

  async findExistingOpen(type: ExceptionType, entityType: EntityType, entityId: string): Promise<PersistedException | null> {
    return this.rows.find((r) => r.type === type && r.entityType === entityType && r.entityId === entityId && r.status === ExceptionStatus.OPEN) ?? null;
  }

  async create(exception: DetectedException): Promise<PersistedException> {
    exceptionIdCounter += 1;
    const row: PersistedException = {
      id: exceptionIdCounter,
      exceptionId: `EXC-VAL-${exceptionIdCounter}`,
      type: exception.type,
      entityType: exception.entityType,
      entityId: exception.entityId,
      severity: exception.severity,
      status: ExceptionStatus.OPEN,
      title: exception.title,
      description: exception.description,
      evidence: exception.evidence,
      detectedAt: exception.detectedAt,
      resolvedAt: null,
      createdAt: exception.detectedAt,
      updatedAt: exception.detectedAt,
    };
    this.rows.push(row);
    return row;
  }

  getAll(): PersistedException[] {
    return [...this.rows];
  }

  getByEntity(entityType: EntityType, entityId: string): PersistedException[] {
    return this.rows.filter((r) => r.entityType === entityType && r.entityId === entityId);
  }
}

export class FakePredictionRepository {
  private rows: PersistedPrediction[] = [];

  reset(): void {
    this.rows = [];
    predictionIdCounter = 0;
  }

  async findActiveOrConfirmed(predictionType: PredictionType, entityType: EntityType, entityId: string): Promise<PersistedPrediction | null> {
    return (
      this.rows.find(
        (r) =>
          r.predictionType === predictionType &&
          r.entityType === entityType &&
          r.entityId === entityId &&
          (r.status === PredictionStatus.ACTIVE || r.status === PredictionStatus.CONFIRMED),
      ) ?? null
    );
  }

  async create(evaluation: PredictionEvaluationResult, status: PredictionStatus, confirmedExceptionId: string | null): Promise<PersistedPrediction> {
    predictionIdCounter += 1;
    const row: PersistedPrediction = {
      id: predictionIdCounter,
      predictionId: `PRED-VAL-${predictionIdCounter}`,
      predictionType: evaluation.predictionType,
      entityType: evaluation.entityType,
      entityId: evaluation.entityId,
      riskScore: evaluation.riskScore,
      riskLevel: evaluation.riskLevel,
      confidence: evaluation.confidence,
      status,
      predictionWindow: evaluation.predictionWindow,
      signals: evaluation.signals,
      explanation: evaluation.explanation,
      limitations: evaluation.limitations,
      confirmedExceptionId,
      predictedAt: evaluation.evaluatedAt,
      resolvedAt: null,
      createdAt: evaluation.evaluatedAt,
      updatedAt: evaluation.evaluatedAt,
    };
    this.rows.push(row);
    return row;
  }

  async update(id: number, evaluation: PredictionEvaluationResult, status: PredictionStatus, confirmedExceptionId: string | null): Promise<PersistedPrediction> {
    const existing = this.rows.find((r) => r.id === id);
    if (!existing) throw new Error(`FakePredictionRepository.update: no row with id ${id}`);
    existing.riskScore = evaluation.riskScore;
    existing.riskLevel = evaluation.riskLevel;
    existing.confidence = evaluation.confidence;
    existing.status = status;
    existing.predictionWindow = evaluation.predictionWindow;
    existing.signals = evaluation.signals;
    existing.explanation = evaluation.explanation;
    existing.limitations = evaluation.limitations;
    existing.confirmedExceptionId = confirmedExceptionId;
    existing.predictedAt = evaluation.evaluatedAt;
    existing.updatedAt = evaluation.evaluatedAt;
    return existing;
  }

  async resolve(id: number): Promise<PersistedPrediction | null> {
    const existing = this.rows.find((r) => r.id === id);
    if (!existing) return null;
    existing.status = PredictionStatus.RESOLVED;
    existing.resolvedAt = existing.predictedAt;
    return existing;
  }

  async findActiveOrConfirmedByType(predictionType: PredictionType): Promise<PersistedPrediction[]> {
    return this.rows.filter((r) => r.predictionType === predictionType && (r.status === PredictionStatus.ACTIVE || r.status === PredictionStatus.CONFIRMED));
  }

  getAll(): PersistedPrediction[] {
    return [...this.rows];
  }

  getByEntity(predictionType: PredictionType, entityType: EntityType, entityId: string): PersistedPrediction[] {
    return this.rows.filter((r) => r.predictionType === predictionType && r.entityType === entityType && r.entityId === entityId);
  }
}

export const fakeExceptionRepository = new FakeExceptionRepository();
export const fakePredictionRepository = new FakePredictionRepository();
