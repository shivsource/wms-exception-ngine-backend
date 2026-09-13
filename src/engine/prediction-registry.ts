import { RiskPredictor } from '../interfaces';
import { DispatchDelayPredictor, InventoryShortagePredictor, PickingDelayPredictor, SlaBreachPredictor } from '../predictors';

/**
 * Single source of truth for which predictors the prediction engine runs. Mirrors
 * RuleRegistry: adding a new predictor means writing its class in src/predictors/ and
 * adding one line here — nothing in the engine, service, or controller ever needs to change.
 */
export class PredictionRegistry {
  private readonly predictors: RiskPredictor[] = [
    new SlaBreachPredictor(),
    new PickingDelayPredictor(),
    new InventoryShortagePredictor(),
    new DispatchDelayPredictor(),
  ];

  getAll(): RiskPredictor[] {
    return this.predictors;
  }

  /** Every predictor whose entityType matches — used by the single-entity evaluation endpoint,
   *  since a given entityId could be an order, a picking task, or a product. */
  getByEntityType(entityType: RiskPredictor['entityType']): RiskPredictor[] {
    return this.predictors.filter((p) => p.entityType === entityType);
  }
}

export const predictionRegistry = new PredictionRegistry();
