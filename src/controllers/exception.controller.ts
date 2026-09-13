import { Request, Response } from 'express';
import { z } from 'zod';
import { actionService } from '../services/action.service';
import { exceptionService } from '../services/exception.service';
import { ExceptionSeverity, ExceptionStatus, ExceptionType } from '../types/enums';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const listQuerySchema = z.object({
  status: z.nativeEnum(ExceptionStatus).optional(),
  severity: z.nativeEnum(ExceptionSeverity).optional(),
  type: z.nativeEnum(ExceptionType).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function listExceptions(req: Request, res: Response): Promise<void> {
  const filters = listQuerySchema.parse(req.query);
  const exceptions = await exceptionService.list(filters);
  res.status(200).json({ success: true, count: exceptions.length, data: exceptions });
}

export async function getExceptionById(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const exception = await exceptionService.getById(id);
  res.status(200).json({ success: true, data: exception });
}

export async function getExceptionEvidence(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const enriched = await exceptionService.getEnriched(id);
  res.status(200).json({ success: true, data: enriched });
}

export async function getExceptionRootCause(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const result = await exceptionService.getRootCause(id);
  res.status(200).json({ success: true, data: result });
}

export async function createExceptionRootCause(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const result = await exceptionService.createRootCauseAnalysis(id);
  res.status(201).json({ success: true, data: result });
}

export async function getExceptionRecommendation(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const result = await exceptionService.getRecommendation(id);
  res.status(200).json({ success: true, data: result });
}

export async function createExceptionRecommendation(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const result = await exceptionService.createRecommendation(id);
  res.status(201).json({ success: true, data: result });
}

export async function getExceptionActions(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  await exceptionService.getById(id);
  const actions = await actionService.listByException(id);
  res.status(200).json({ success: true, count: actions.length, data: actions });
}

export async function listOpenExceptions(_req: Request, res: Response): Promise<void> {
  const exceptions = await exceptionService.listOpen();
  res.status(200).json({ success: true, count: exceptions.length, data: exceptions });
}

export async function listCriticalExceptions(_req: Request, res: Response): Promise<void> {
  const exceptions = await exceptionService.listCritical();
  res.status(200).json({ success: true, count: exceptions.length, data: exceptions });
}

export async function runEngine(_req: Request, res: Response): Promise<void> {
  const summary = await exceptionService.runEngine();
  res.status(200).json({ success: true, data: summary });
}

export async function resolveException(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const resolved = await exceptionService.resolve(id);
  res.status(200).json({ success: true, data: resolved });
}
