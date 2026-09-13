import { ValidationReport } from './metrics';

/** Human-readable console report — mirrors the layout in the validation brief (Section 36). */

function pct(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(2)}%`;
}

function mins(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(1)} min`;
}

function line(char = '=', width = 78): string {
  return char.repeat(width);
}

export function formatValidationReport(report: ValidationReport): string {
  const out: string[] = [];
  const { summary } = report;

  out.push(line());
  out.push('WMS PREDICTION VALIDATION REPORT');
  out.push(line());
  out.push('');
  out.push(`Generated:          ${report.generatedAt.toISOString()}`);
  out.push(`Scenario results:   ${summary.totalScenarioResults}`);
  out.push(`Predictions made:   ${summary.totalPredictions}`);
  out.push('');
  out.push(`True Positives:        ${summary.truePositives}`);
  out.push(`False Positives:       ${summary.falsePositives}`);
  out.push(`False Negatives:       ${summary.falseNegatives}`);
  out.push(`True Negatives:        ${summary.trueNegatives}`);
  out.push(`Not Measurable:        ${summary.notMeasurable}`);
  out.push(`Confirmed-before-pred: ${summary.confirmedBeforePrediction}`);
  out.push(`Pending:               ${summary.pending}`);
  out.push('');
  out.push(line('-'));
  out.push('CONFUSION MATRIX');
  out.push(line('-'));
  out.push('                     Actual: YES        Actual: NO');
  out.push(`Predicted: YES       TP=${summary.truePositives}${' '.repeat(Math.max(1, 15 - String(summary.truePositives).length))}FP=${summary.falsePositives}`);
  out.push(`Predicted: NO        FN=${summary.falseNegatives}${' '.repeat(Math.max(1, 15 - String(summary.falseNegatives).length))}TN=${summary.trueNegatives}`);
  out.push('');
  out.push(line('-'));
  out.push('OVERALL — PREDICTION QUALITY');
  out.push(line('-'));
  out.push(`Precision:               ${pct(summary.precision)}`);
  out.push(`Recall:                  ${pct(summary.recall)}`);
  out.push(`F1 Score:                ${pct(summary.f1Score)}`);
  out.push(`False Positive Rate:     ${pct(summary.falsePositiveRate)}`);
  out.push('');
  out.push(line('-'));
  out.push('OVERALL — EARLY WARNING QUALITY');
  out.push(line('-'));
  out.push(`Average Warning Time:    ${mins(summary.warningTime.averageMinutes)}`);
  out.push(`Median Warning Time:     ${mins(summary.warningTime.medianMinutes)}`);
  out.push(`Minimum Warning Time:    ${mins(summary.warningTime.minMinutes)}`);
  out.push(`Maximum Warning Time:    ${mins(summary.warningTime.maxMinutes)}`);
  out.push(`P25 Warning Time:        ${mins(summary.warningTime.p25Minutes)}`);
  out.push(`P75 Warning Time:        ${mins(summary.warningTime.p75Minutes)}`);
  out.push('');
  out.push('Warning-time buckets (TRUE_POSITIVE only):');
  for (const [bucket, count] of Object.entries(summary.warningTimeBuckets)) {
    out.push(`  ${bucket.padEnd(16)} ${count}`);
  }
  out.push('');
  out.push(line('-'));
  out.push('OVERALL — OPERATIONAL USEFULNESS');
  out.push(line('-'));
  out.push(`>30 min warning:  ${pct(summary.operationalUsefulness.pctOver30Min)}`);
  out.push(`>60 min warning:  ${pct(summary.operationalUsefulness.pctOver60Min)}`);
  out.push(`<5 min warning:   ${pct(summary.operationalUsefulness.pctUnder5Min)}`);
  out.push('');
  out.push(line('-'));
  out.push('BY PREDICTION TYPE');
  out.push(line('-'));
  for (const metrics of Object.values(report.byPredictionType)) {
    out.push('');
    out.push(metrics.predictionType);
    out.push(`  Predictions:   ${metrics.totalPredictions}  (TP=${metrics.truePositives} FP=${metrics.falsePositives} FN=${metrics.falseNegatives} TN=${metrics.trueNegatives} NOT_MEASURABLE=${metrics.notMeasurable})`);
    out.push(`  Precision:     ${pct(metrics.precision)}`);
    out.push(`  Recall:        ${pct(metrics.recall)}`);
    out.push(`  F1:            ${pct(metrics.f1Score)}`);
    out.push(`  Avg Warning:   ${mins(metrics.warningTime.averageMinutes)}`);
  }
  out.push('');
  out.push(line('-'));
  out.push('SCENARIO RESULTS');
  out.push(line('-'));
  for (const s of report.scenarioResults) {
    const predAt = s.prediction ? s.prediction.predictedAt.toISOString() : 'NONE';
    const excAt = s.actualOutcome.exceptionTimestamp ? s.actualOutcome.exceptionTimestamp.toISOString() : 'NONE';
    out.push('');
    out.push(`${s.scenarioId} (target ${s.targetIndex})  ${s.scenarioName}`);
    out.push(`  Entity:     ${s.entityType} ${s.entityId} / ${s.predictionType}`);
    out.push(`  Prediction: ${predAt}`);
    out.push(`  Actual:     ${excAt}`);
    out.push(`  Result:     ${s.validation.result}${s.validation.result === 'TRUE_POSITIVE' ? ` (warning: ${mins(s.validation.warningTimeMinutes)}, ${s.validation.warningQuality})` : ''}`);
    out.push(`  Expected:   ${s.expectedResult}  ->  ${s.passed ? 'PASS' : 'FAIL'}`);
    if (s.idempotencyPassed !== null) out.push(`  Idempotent: ${s.idempotencyPassed ? 'YES' : 'NO'}`);
  }
  out.push('');
  out.push(line());
  out.push('FINAL INTERPRETATION');
  out.push(line());
  out.push('');
  out.push(`Prediction accuracy:     ${report.interpretation.accuracy}`);
  out.push(`Early warning quality:   ${report.interpretation.earlyWarningQuality}`);
  out.push(`Prediction coverage:     ${report.interpretation.coverage}`);
  out.push(`Data limitations:        ${report.interpretation.dataLimitations}`);
  out.push('');
  out.push(`Sample size warning:     ${report.interpretation.sampleSizeWarning}`);
  out.push('');
  out.push(report.sampleSizeDisclaimer);
  out.push('');
  out.push(line());

  return out.join('\n');
}
