import { Router } from 'express';
import { login } from '../controllers/auth.controller';
import { asyncHandler } from '../utils/asyncHandler';

export const authRouter = Router();

authRouter.post('/login', asyncHandler(login));
