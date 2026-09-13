import { MockLogisticsDataSource, MockLogisticsDataSourceSeed } from '../adapters/mock';
import { exceptionEngine, predictionEngine } from '../engine';
import { predictionRegistry } from '../engine/prediction-registry';
import { PersistedPrediction } from '../interfaces';
import { PREDICTS_EXCEPTION_TYPE } from '../predictors';
import { fakeExceptionRepository, fakePredictionRepository } from './fakes';
import { classifyWarningQuality, evaluatePrediction, isMeaningfulRiskLevel } from './matching';
import { ExceptionSnapshot, PredictionSnapshot, PredictionValidationScenario, ScenarioResult, ValidationTarget } from './types';

/**
 * The simulation engine (Section 4). Owns simulated time progression and orchestrates the
 * REAL, unmodified PredictionEngine and ExceptionEngine (src/engine/*.ts) against a
 * scenario's timeline — it contains no scoring or detection logic of its own. `setSystemTime`
 * is injected by the caller (a vitest fake-timer) so this module has no vitest dependency of
 * its own and stays a plain orchestrator (Section 4: "not a production-grade event
 * simulation platform").
 *
 * No-leakage guarantee (Section 22/23): each timeline step re-seeds MockLogisticsDataSource
 * with EXACTLY the operational snapshot the scenario author wrote for that instant — nothing
 * from a later step is ever visible earlier, because the data source is fully replaced
 * (`.seed()`), not accumulated, and simulated time is set before the engines run.
 */

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function targetKey(target: ValidationTarget): string {
  return `${target.predictionType}|${target.entityType}|${target.entityId}`;
}

/** Fully empties every array — applied before a scenario's first step so nothing from a
 *  previously run scenario (the mock data source instance is reused across the whole suite)
 *  can leak in. See TimelineStep's doc comment for why partial per-step seeds are otherwise
 *  safe (Section 22/23). */
function emptySeed(): Required<MockLogisticsDataSourceSeed> {
  return { orders: [], products: [], inventory: [], pickingTasks: [], packing: [], dispatch: [], returns: [] };
}

/** Collapses one (predictionType, entity)'s full observation history into a single episode
 *  snapshot (Section 27/28): the EARLIEST meaningful (>= MEDIUM risk) observation defines
 *  `predictedAt` and is preserved verbatim (Section 6) — later re-evaluations only update
 *  `highestRiskScore`/`finalStatus`, never overwrite the original prediction. */
function buildEpisodeSnapshot(history: PersistedPrediction[]): PredictionSnapshot | null {
  const meaningful = history.filter((r) => isMeaningfulRiskLevel(r.riskLevel));
  if (meaningful.length === 0) return null;
  const first = meaningful[0] as PersistedPrediction;
  const last = history[history.length - 1] as PersistedPrediction;
  const highestRiskScore = history.reduce((max, r) => Math.max(max, r.riskScore ?? 0), 0);

  return {
    predictionId: first.predictionId,
    predictionType: first.predictionType,
    entityType: first.entityType,
    entityId: first.entityId,
    predictedAt: first.predictedAt,
    riskScore: first.riskScore,
    riskLevel: first.riskLevel,
    highestRiskScore,
    confidence: first.confidence,
    predictionWindow: first.predictionWindow,
    signals: first.signals,
    explanation: first.explanation,
    finalStatus: last.status as 'ACTIVE' | 'CONFIRMED' | 'RESOLVED',
    confirmedExceptionId: last.confirmedExceptionId,
    observationCount: history.length,
  };
}

interface SimulationDeps {
  dataSource: MockLogisticsDataSource;
  setSystemTime: (date: Date) => void;
}

async function runInsufficientDataScenario(scenario: PredictionValidationScenario): Promise<ScenarioResult[]> {
  const target = scenario.targets[0] as ValidationTarget;
  const predictor = predictionRegistry.getAll().find((p) => p.predictionType === target.predictionType);
  if (!predictor) throw new Error(`No registered predictor for ${target.predictionType}`);

  const entityId = scenario.insufficientDataEntityId as string;
  const evaluation = await predictor.evaluateOne(entityId);
  const result = evaluation.status === 'INSUFFICIENT_DATA' ? 'NOT_MEASURABLE' : 'TRUE_NEGATIVE';

  return [
    {
      scenarioId: scenario.scenarioId,
      scenarioName: scenario.name,
      targetIndex: 0,
      predictionType: target.predictionType,
      entityType: target.entityType,
      entityId,
      prediction: null,
      actualOutcome: { exceptionOccurred: false, exceptionType: null, exceptionTimestamp: null, exceptionId: null },
      validation: { result, warningTimeMinutes: null, warningQuality: 'NOT_APPLICABLE' },
      expectedResult: target.expectedResult,
      passed: result === target.expectedResult,
      idempotencyPassed: null,
    },
  ];
}

export async function runScenario(scenario: PredictionValidationScenario, deps: SimulationDeps): Promise<ScenarioResult[]> {
  fakeExceptionRepository.reset();
  fakePredictionRepository.reset();
  deps.dataSource.seed(emptySeed());

  if (scenario.insufficientDataEntityId) {
    deps.setSystemTime(scenario.t0);
    return runInsufficientDataScenario(scenario);
  }

  for (const pre of scenario.preExistingExceptions ?? []) {
    fakeExceptionRepository.seedExisting({
      type: pre.type,
      entityType: pre.entityType,
      entityId: pre.entityId,
      severity: pre.severity,
      title: `Pre-existing ${pre.type} for ${pre.entityId}`,
      description: null,
      evidence: null,
      detectedAt: addMinutes(scenario.t0, pre.detectedAtOffsetMinutes),
    });
  }

  const predictionHistoryByTarget = new Map<string, PersistedPrediction[]>();
  const exceptionHistoryByTarget = new Map<string, ExceptionSnapshot[]>();
  let simulationEndTime = scenario.t0;

  for (const step of scenario.timeline) {
    const stepTime = addMinutes(scenario.t0, step.offsetMinutes);
    simulationEndTime = stepTime;
    deps.setSystemTime(stepTime);
    deps.dataSource.seed(step.state);

    await predictionEngine.run();
    await exceptionEngine.run();

    for (const target of scenario.targets) {
      const key = targetKey(target);

      const predRows = fakePredictionRepository.getByEntity(target.predictionType, target.entityType, target.entityId);
      const latestPred = predRows[predRows.length - 1];
      if (latestPred) {
        const history = predictionHistoryByTarget.get(key) ?? [];
        history.push({ ...latestPred });
        predictionHistoryByTarget.set(key, history);
      }

      const exceptionType = PREDICTS_EXCEPTION_TYPE[target.predictionType];
      const excRows = fakeExceptionRepository.getByEntity(target.entityType, target.entityId).filter((e) => e.type === exceptionType);
      const history = exceptionHistoryByTarget.get(key) ?? [];
      for (const row of excRows) {
        if (!history.some((h) => h.exceptionId === row.exceptionId)) {
          history.push({ exceptionId: row.exceptionId, type: row.type, entityType: row.entityType, entityId: row.entityId, detectedAt: row.detectedAt });
        }
      }
      exceptionHistoryByTarget.set(key, history);
    }
  }

  let idempotencyPassed: boolean | null = null;
  if (scenario.verifyIdempotencyAtEnd) {
    const predictionRowCountBefore = fakePredictionRepository.getAll().length;
    const exceptionRowCountBefore = fakeExceptionRepository.getAll().length;
    // Re-run at the exact same simulated instant, with no state change — a real duplicate-run
    // check (Section 13/21), not a new timestep.
    await predictionEngine.run();
    await exceptionEngine.run();
    await predictionEngine.run();
    await exceptionEngine.run();
    idempotencyPassed = fakePredictionRepository.getAll().length === predictionRowCountBefore && fakeExceptionRepository.getAll().length === exceptionRowCountBefore;
  }

  return scenario.targets.map((target, targetIndex) => {
    const key = targetKey(target);
    const prediction = buildEpisodeSnapshot(predictionHistoryByTarget.get(key) ?? []);
    const candidateExceptions = exceptionHistoryByTarget.get(key) ?? [];

    const outcome = evaluatePrediction({ prediction, candidateExceptions, simulationEndTime });
    const matched = outcome.matchedException;

    return {
      scenarioId: scenario.scenarioId,
      scenarioName: scenario.name,
      targetIndex,
      predictionType: target.predictionType,
      entityType: target.entityType,
      entityId: target.entityId,
      prediction,
      actualOutcome: {
        exceptionOccurred: candidateExceptions.length > 0,
        exceptionType: candidateExceptions[0]?.type ?? null,
        exceptionTimestamp: matched?.detectedAt ?? candidateExceptions[0]?.detectedAt ?? null,
        exceptionId: matched?.exceptionId ?? candidateExceptions[0]?.exceptionId ?? null,
      },
      validation: {
        result: outcome.result,
        warningTimeMinutes: outcome.warningTimeMinutes,
        warningQuality: classifyWarningQuality(outcome.warningTimeMinutes),
      },
      expectedResult: target.expectedResult,
      passed: outcome.result === target.expectedResult,
      idempotencyPassed,
    };
  });
}
