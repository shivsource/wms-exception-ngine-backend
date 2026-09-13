import { Router } from 'express';
import {
  createExceptionRecommendation,
  createExceptionRootCause,
  getExceptionActions,
  getExceptionById,
  getExceptionEvidence,
  getExceptionRecommendation,
  getExceptionRootCause,
  listCriticalExceptions,
  listExceptions,
  listOpenExceptions,
  resolveException,
  runEngine,
} from '../controllers/exception.controller';
import { asyncHandler } from '../utils/asyncHandler';

export const exceptionRouter = Router();

// Static-path routes must be registered before the "/:id" catch-all below.
exceptionRouter.get('/open', asyncHandler(listOpenExceptions));
exceptionRouter.get('/critical', asyncHandler(listCriticalExceptions));
exceptionRouter.post('/run', asyncHandler(runEngine));

exceptionRouter.get('/', asyncHandler(listExceptions));
exceptionRouter.get('/:id', asyncHandler(getExceptionById));
exceptionRouter.get('/:id/evidence', asyncHandler(getExceptionEvidence));
exceptionRouter.get('/:id/root-cause', asyncHandler(getExceptionRootCause));
exceptionRouter.post('/:id/root-cause', asyncHandler(createExceptionRootCause));
exceptionRouter.get('/:id/recommendation', asyncHandler(getExceptionRecommendation));
exceptionRouter.post('/:id/recommendation', asyncHandler(createExceptionRecommendation));
exceptionRouter.get('/:id/actions', asyncHandler(getExceptionActions));
exceptionRouter.post('/:id/resolve', asyncHandler(resolveException));
