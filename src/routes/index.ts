import { Router } from 'express';
import { actionRouter } from './action.routes';
import { authRouter } from './auth.routes';
import { exceptionRouter } from './exception.routes';
import { healthRouter } from './health.routes';
import { predictionRouter } from './prediction.routes';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/exceptions', exceptionRouter);
apiRouter.use('/actions', actionRouter);
apiRouter.use('/predictions', predictionRouter);
// Only auth is namespaced under /api — every other route here is mounted at its bare path
// (see above), so this is a deliberately scoped exception to match this endpoint's required
// contract (POST /api/auth/login) rather than a project-wide "/api" prefix change.
apiRouter.use('/api/auth', authRouter);
