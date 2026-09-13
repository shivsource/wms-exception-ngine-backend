import { exceptionEngine } from '../engine';
import { EngineRunSummary, EnrichedException, PersistedException, RecommendationResult, RootCauseAnalysis } from '../interfaces';
import {
  ExceptionFilters,
  exceptionRecommendationRepository,
  exceptionRepository,
  PersistedExceptionRecommendation,
  PersistedRootCauseAnalysis,
  rootCauseAnalysisRepository,
} from '../repositories';
import { evidenceService } from './evidence.service';
import { explanationService } from './explanation.service';
import { recommendationService } from './recommendation.service';
import { rootCauseService } from './root-cause.service';
import { AppError } from '../utils/AppError';

export type RootCauseView = { exception: PersistedException } & RootCauseAnalysis;
export type RecommendationView = { exception: PersistedException } & RecommendationResult;

export class ExceptionService {
  async list(filters: ExceptionFilters): Promise<PersistedException[]> {
    return exceptionRepository.findAll(filters);
  }

  async getById(id: number): Promise<PersistedException> {
    const exception = await exceptionRepository.findById(id);
    if (!exception) {
      throw AppError.notFound(`Exception ${id} not found`);
    }
    return exception;
  }

  async listOpen(): Promise<PersistedException[]> {
    return exceptionRepository.findOpen();
  }

  async listCritical(): Promise<PersistedException[]> {
    return exceptionRepository.findCritical();
  }

  async runEngine(): Promise<EngineRunSummary> {
    return exceptionEngine.run();
  }

  async getEnriched(id: number): Promise<EnrichedException> {
    const exception = await this.getById(id);
    const structuredEvidence = await evidenceService.collect(exception);
    const explanation = explanationService.explain(exception, structuredEvidence);
    return { ...exception, structuredEvidence, explanation };
  }

  /** Computes root cause fresh from current DB state — a pure read, like getEnriched. */
  async getRootCause(id: number): Promise<RootCauseView> {
    const exception = await this.getById(id);
    const analysis = await this.analyzeRootCause(exception);
    return { exception, ...analysis };
  }

  /** Computes root cause and persists a snapshot — the mutating counterpart to getRootCause. */
  async createRootCauseAnalysis(id: number): Promise<PersistedRootCauseAnalysis> {
    const exception = await this.getById(id);
    const analysis = await this.analyzeRootCause(exception);
    return rootCauseAnalysisRepository.create(exception.id, analysis);
  }

  private async analyzeRootCause(exception: PersistedException): Promise<RootCauseAnalysis> {
    const structuredEvidence = await evidenceService.collect(exception);
    const analysis = await rootCauseService.analyze(exception, structuredEvidence);
    if (!analysis) {
      throw new AppError(
        `Root cause analysis is not available for exception ${exception.id} (type ${exception.type})`,
        422,
      );
    }
    return analysis;
  }

  /** Computes a recommendation fresh from current root cause/evidence state — a pure read. */
  async getRecommendation(id: number): Promise<RecommendationView> {
    const exception = await this.getById(id);
    const recommendation = await this.buildRecommendation(exception);
    return { exception, ...recommendation };
  }

  /** Computes a recommendation and persists a snapshot — the mutating counterpart to getRecommendation. */
  async createRecommendation(id: number): Promise<PersistedExceptionRecommendation> {
    const exception = await this.getById(id);
    const recommendation = await this.buildRecommendation(exception);
    return exceptionRecommendationRepository.create(exception.id, recommendation);
  }

  private async buildRecommendation(exception: PersistedException): Promise<RecommendationResult> {
    const structuredEvidence = await evidenceService.collect(exception);
    const rootCauseAnalysis = await rootCauseService.analyze(exception, structuredEvidence);
    const recommendation = await recommendationService.recommend(exception, structuredEvidence, rootCauseAnalysis);
    if (!recommendation) {
      throw new AppError(
        `Recommendation is not available for exception ${exception.id} (type ${exception.type})`,
        422,
      );
    }
    return recommendation;
  }

  async resolve(id: number): Promise<PersistedException> {
    const existing = await exceptionRepository.findById(id);
    if (!existing) {
      throw AppError.notFound(`Exception ${id} not found`);
    }

    const resolved = await exceptionRepository.resolve(id);
    if (!resolved) {
      throw new AppError(`Failed to resolve exception ${id}`, 500);
    }
    return resolved;
  }
}

export const exceptionService = new ExceptionService();
