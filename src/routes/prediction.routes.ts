import { Router } from 'express';
import {
  evaluatePredictionEntity,
  getPredictionById,
  getPredictionsForEntity,
  listPredictions,
  runPredictionEvaluation,
} from '../controllers/prediction.controller';
import { asyncHandler } from '../utils/asyncHandler';

export const predictionRouter = Router();

// Static-path routes must be registered before the "/:id" catch-all below.
predictionRouter.post('/evaluate', asyncHandler(runPredictionEvaluation));
predictionRouter.post('/evaluate/:entityType/:entityId', asyncHandler(evaluatePredictionEntity));
predictionRouter.get('/entity/:entityId', asyncHandler(getPredictionsForEntity));

predictionRouter.get('/', asyncHandler(listPredictions));
predictionRouter.get('/:id', asyncHandler(getPredictionById));
