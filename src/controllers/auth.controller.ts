import { Request, Response } from 'express';
import { env } from '../config/env';

/**
 * Prototype login only: hardcoded single-operator credentials via env vars, no users table,
 * no session/JWT. Response shapes here are a deliberate, literal API contract (flat
 * `message`, generic "Invalid email or password" that never reveals which field was wrong) —
 * validated manually rather than via the app's usual `zodSchema.parse(req.body)` convention,
 * since a ZodError would be caught by the shared errorHandler and wrapped as
 * `{ success: false, error: { message, details } }` instead of this endpoint's flat shape.
 */
export async function login(req: Request, res: Response): Promise<void> {
  const body = req.body as { email?: unknown; password?: unknown } | null | undefined;
  const email = typeof body?.email === 'string' ? body.email : undefined;
  const password = typeof body?.password === 'string' ? body.password : undefined;

  if (!email || !password) {
    res.status(400).json({ success: false, message: 'Email and password are required' });
    return;
  }

  if (email !== env.AUTH_EMAIL || password !== env.AUTH_PASSWORD) {
    res.status(401).json({ success: false, message: 'Invalid email or password' });
    return;
  }

  res.status(200).json({ success: true, message: 'Login successful', data: { email } });
}
