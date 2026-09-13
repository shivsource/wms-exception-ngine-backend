import { EvidenceCollector } from '../interfaces';
import { ExceptionType } from '../types/enums';
import { DispatchDelayEvidenceCollector } from './dispatch-delay.evidence';
import { ExcessivePickerDistanceEvidenceCollector } from './excessive-picker-distance.evidence';
import { ExcessivePickingTimeEvidenceCollector } from './excessive-picking-time.evidence';
import { HighReturnRateEvidenceCollector } from './high-return-rate.evidence';
import { InventoryDiscrepancyEvidenceCollector } from './inventory-discrepancy.evidence';
import { InventoryShortageEvidenceCollector } from './inventory-shortage.evidence';
import { PackingDelayEvidenceCollector } from './packing-delay.evidence';
import { PickingDelayEvidenceCollector } from './picking-delay.evidence';
import { PickingErrorEvidenceCollector } from './picking-error.evidence';
import { SlaAtRiskEvidenceCollector } from './sla-at-risk.evidence';

export * from './dispatch-delay.evidence';
export * from './excessive-picker-distance.evidence';
export * from './excessive-picking-time.evidence';
export * from './high-return-rate.evidence';
export * from './inventory-discrepancy.evidence';
export * from './inventory-shortage.evidence';
export * from './packing-delay.evidence';
export * from './picking-delay.evidence';
export * from './picking-error.evidence';
export * from './sla-at-risk.evidence';

/**
 * Single source of truth for which collector handles which exception type. Adding
 * evidence support for a new type means writing the collector class in this
 * directory and adding one line here — EvidenceService never needs to change.
 */
export class EvidenceCollectorRegistry {
  private readonly byType: ReadonlyMap<ExceptionType, EvidenceCollector>;

  constructor(collectors: EvidenceCollector[]) {
    this.byType = new Map(collectors.map((collector) => [collector.exceptionType, collector]));
  }

  get(type: ExceptionType): EvidenceCollector | undefined {
    return this.byType.get(type);
  }
}

export const evidenceCollectorRegistry = new EvidenceCollectorRegistry([
  new PickingDelayEvidenceCollector(),
  new PickingErrorEvidenceCollector(),
  new ExcessivePickingTimeEvidenceCollector(),
  new ExcessivePickerDistanceEvidenceCollector(),
  new SlaAtRiskEvidenceCollector(),
  new PackingDelayEvidenceCollector(),
  new DispatchDelayEvidenceCollector(),
  new HighReturnRateEvidenceCollector(),
  new InventoryShortageEvidenceCollector(),
  new InventoryDiscrepancyEvidenceCollector(),
]);
