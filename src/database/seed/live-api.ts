import * as http from 'node:http';
import { URL } from 'node:url';

/**
 * Talks to the already-running app server (the same one the live SCHEDULER_CRON scheduler
 * runs inside) to trigger real prediction/exception evaluations against the freshly-seeded
 * data — rather than re-instantiating a second engine/pool inside this script. This is the
 * "no engine/orchestration modification" path: it only calls the existing, unmodified
 * POST /predictions/evaluate and POST /exceptions/run endpoints (see prediction.routes.ts,
 * exception.routes.ts) exactly as any operator or the cron scheduler already does.
 *
 * Uses node:http directly rather than global fetch: undici's fetch implements the WHATWG
 * "bad port" blocklist (the same list browsers use), which includes port 6000 (historically
 * X11) — this app's own configured PORT (.env) — so fetch() unconditionally rejects every
 * request to it with "TypeError: fetch failed / bad port". http.request has no such list.
 */
const BASE_URL = process.env.SEED_APP_URL ?? 'http://localhost:6000';

function request(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function post(path: string): Promise<unknown> {
  const { status, body } = await request('POST', path);
  if (status < 200 || status >= 300) {
    throw new Error(`POST ${path} failed: ${status} ${body}`);
  }
  return JSON.parse(body);
}

export async function runPredictionEvaluation(): Promise<unknown> {
  return post('/predictions/evaluate');
}

export async function runExceptionDetection(): Promise<unknown> {
  return post('/exceptions/run');
}

export async function evaluatePredictionEntity(entityType: string, entityId: string): Promise<unknown> {
  return post(`/predictions/evaluate/${entityType}/${encodeURIComponent(entityId)}`);
}

export async function checkAppReachable(): Promise<boolean> {
  try {
    const { status } = await request('GET', '/health');
    return status === 200;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
