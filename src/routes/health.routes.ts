import { Router } from 'express';
import { getHealth } from '../controllers/health.controller';
import { asyncHandler } from '../utils/asyncHandler';

export const healthRouter = Router();

healthRouter.get('/', asyncHandler(getHealth));
