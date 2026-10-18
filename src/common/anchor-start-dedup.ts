import { createHash } from 'crypto';
import { pool } from '../db/pool';
import { AnchorInteractiveSession } from './anchor-client';

// Server-side idempotency for starting a SEP-24 interactive session. The
// anchor mints a new transaction on every successful start, so two inbound
// requests for the same (direction, account, currency, token) must resolve
// to one anchor call. Same idea as x402.service.ts's idempotencyKey, plus an
// advisory lock (fees.service.ts's createSettlement pattern) so two
// *concurrent* requests serialize instead of both missing the lookup.
export function startIdempotencyKey(direction: string, account: string, currency: string, token: string): string {
  return createHash('sha256').update(JSON.stringify([direction, account, currency, token])).digest('hex');
}

export async function startInteractiveOnce(
  direction: 'deposit' | 'withdraw',
  account: string,
  currency: string,
  token: string,
  start: () => Promise<AnchorInteractiveSession>,
): Promise<AnchorInteractiveSession> {
  const key = startIdempotencyKey(direction, account, currency, token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`anchor-start:${key}`]);
    const existing = await client.query<{ session: AnchorInteractiveSession }>(
      'SELECT session FROM anchor_interactive_sessions WHERE idempotency_key = $1',
      [key],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return existing.rows[0].session;
    }
    const session = await start();
    await client.query(
      `INSERT INTO anchor_interactive_sessions (idempotency_key, direction, session) VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, direction, JSON.stringify(session)],
    );
    await client.query('COMMIT');
    return session;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
