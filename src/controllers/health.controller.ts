import { Request, Response } from 'express';
import { pingDatabase } from '../database';

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const databaseConnected = await pingDatabase();

  res.status(databaseConnected ? 200 : 503).json({
    success: databaseConnected,
    status: databaseConnected ? 'ok' : 'degraded',
    database: databaseConnected ? 'connected' : 'unreachable',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
}
