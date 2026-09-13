import { MockLogisticsDataSource } from '../adapters/mock';
import { buildValidationReport, ValidationReport } from './metrics';
import { validationScenarios } from './scenarios';
import { runScenario } from './simulation-engine';
import { ScenarioResult } from './types';

export interface ValidationSuiteDeps {
  dataSource: MockLogisticsDataSource;
  setSystemTime: (date: Date) => void;
}

/** Runs every scenario in validationScenarios.ts in order and builds the aggregate report. */
export async function runValidationSuite(deps: ValidationSuiteDeps): Promise<{ report: ValidationReport; results: ScenarioResult[] }> {
  const results: ScenarioResult[] = [];
  for (const scenario of validationScenarios) {
    const scenarioResults = await runScenario(scenario, deps);
    results.push(...scenarioResults);
  }
  return { report: buildValidationReport(results), results };
}
