import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    logger.warn('Request validation failed', { path: req.originalUrl, issues: err.issues });
    res.status(400).json({
      success: false,
      error: { message: 'Validation failed', details: err.flatten() },
    });
    return;
  }

  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const message = err instanceof Error ? err.message : 'Internal server error';

  if (!isAppError || !err.isOperational) {
    logger.error('Unhandled error', { error: err instanceof Error ? err.stack : err });
  } else {
    logger.warn(message, { statusCode, path: req.originalUrl });
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
    },
  });
}
