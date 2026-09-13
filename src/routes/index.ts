import { Router } from 'express';
import { actionRouter } from './action.routes';
import { exceptionRouter } from './exception.routes';
import { healthRouter } from './health.routes';
import { predictionRouter } from './prediction.routes';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/exceptions', exceptionRouter);
apiRouter.use('/actions', actionRouter);
apiRouter.use('/predictions', predictionRouter);
