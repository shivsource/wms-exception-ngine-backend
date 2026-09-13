import { Request, Response } from 'express';
import { z } from 'zod';
import { actionService } from '../services/action.service';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const createActionSchema = z.object({ exceptionId: z.coerce.number().int().positive() });

export async function createAction(req: Request, res: Response): Promise<void> {
  const { exceptionId } = createActionSchema.parse(req.body);
  const action = await actionService.createFromException(exceptionId);
  res.status(201).json({ success: true, data: action });
}

export async function getActionById(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const action = await actionService.getById(id);
  res.status(200).json({ success: true, data: action });
}

export async function approveAction(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const action = await actionService.approve(id);
  res.status(200).json({ success: true, data: action });
}

export async function executeAction(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const result = await actionService.execute(id);
  res.status(result.alreadyExecuted ? 200 : 201).json({ success: true, data: result });
}

export async function getActionOutcome(req: Request, res: Response): Promise<void> {
  const { id } = idParamSchema.parse(req.params);
  const outcome = await actionService.getOutcome(id);
  res.status(200).json({ success: true, data: outcome });
}
