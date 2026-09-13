import { Router } from 'express';
import { approveAction, createAction, executeAction, getActionById, getActionOutcome } from '../controllers/action.controller';
import { asyncHandler } from '../utils/asyncHandler';

export const actionRouter = Router();

actionRouter.post('/', asyncHandler(createAction));
actionRouter.get('/:id', asyncHandler(getActionById));
actionRouter.post('/:id/approve', asyncHandler(approveAction));
actionRouter.post('/:id/execute', asyncHandler(executeAction));
actionRouter.get('/:id/outcome', asyncHandler(getActionOutcome));
