import { Request, Response } from 'express';
import { z } from 'zod';
import { predictionService } from '../services/prediction.service';
import { EntityType, PredictionStatus, PredictionType, RiskLevel } from '../types/enums';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const entityParamSchema = z.object({ entityId: z.string().min(1) });

const evaluateEntityParamSchema = z.object({
  entityType: z.nativeEnum(EntityType),
  entityId: z.string().min(1),
});

const listQuerySchema = z.object({
  status: z.nativeEnum(PredictionStatus).optional(),
  riskLevel: z.nativeEnum(RiskLevel).optional(),
  predictionType: z.nativeEnum(PredictionType).optional(),
  entityType: z.nativeEnum(EntityType).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function runPredictionEvaluation(_req: Request, res: Response): Promise<void> {
  const summary = await predictionService.runEvaluation();
  res.status(200).json({ success: true, data: summary });
}

export async function evaluatePredictionEntity(req: Request, res: Response): Promise<void> {
  const { entityType, entityId } = evaluateEntityParamSchema.parse(req.params);
  const result = await predictionService.evaluateEntity(entityType, entityId);
  res.status(200).json({ success: true, data: result });
}

export async function listPredictions(req: Request, res: Response): Promise<void> {
  const filters = listQuerySchema.parse(req.query);
  const predictions = await predictionService.list(filters);
  res.status(200).json({ success: true, count: predictions.length, data: predictions });
}

export async function getPredictionById(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const prediction = await predictionService.getById(id);
  res.status(200).json({ success: true, data: prediction });
}

export async function getPredictionsForEntity(req: Request, res: Response): Promise<void> {
  const { entityId } = entityParamSchema.parse(req.params);
  const result = await predictionService.getByEntityId(entityId);
  res.status(200).json({ success: true, data: result });
}
