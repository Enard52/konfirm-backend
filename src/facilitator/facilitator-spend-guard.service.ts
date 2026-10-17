import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

const HALT_KEY = 'halted_at';
const HALT_REASON_KEY = 'halt_reason';
const SPEND_GUARD_LOCK_KEY = 402_005;

// A tunable ceiling, not a hardcoded guess -- how much daily exposure is
// acceptable is an operational/business call, not something to bake into
// code. Deliberately no fallback that silently disables the cap (an unset
// env var defaults to a conservative $0, meaning "not configured" fails
// closed too, consistent with everything else in this guard).
function dailyCapUsdc(): number {
  return Number(process.env.FACILITATOR_DAILY_SPEND_CAP_USDC ?? '0');
}

export class FacilitatorSpendCapExceeded extends Error {}
export class FacilitatorHalted extends Error {}

/**
 * Bounds the blast radius of a compromised *application* (not just a
 * leaked key) abusing its own legitimate KMS signing access -- a
 * different threat from what onchain-compliance.ts's isAllowedOnChain
 * defends against, which is deliberately why this fails closed where that
 * one fails open. If this can't determine today's spend (DB unreachable),
 * it refuses to sign rather than proceeding -- the opposite default,
 * because this exists specifically to bound financial risk, not to avoid
 * blocking a legitimate payment during an infra blip.
 *
 * A cap breach halts ALL further signing, not just the one over-cap
 * operation, until an admin explicitly resumes it (see
 * FacilitatorController's /admin/facilitator/resume) -- the threat model
 * here is "something is already wrong," so the safe default is a human
 * looking at it, not an automatic reset at midnight.
 */
@Injectable()
export class FacilitatorSpendGuardService {
  private readonly logger = new Logger(FacilitatorSpendGuardService.name);

  async checkAndRecordSpend(amountUsdc: number, operation: string, reference?: string): Promise<void> {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query('SELECT pg_advisory_xact_lock($1)', [SPEND_GUARD_LOCK_KEY]);

      const [haltResult, spendResult] = await Promise.all([
        client.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_KEY]),
        client.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM facilitator_spend_log WHERE created_at >= date_trunc('day', NOW())`,
        ),
      ]);
      const halted = haltResult.rows[0];
      if (halted) {
        throw new FacilitatorHalted(
          `facilitator signing is halted (since ${halted.value}) pending manual review -- ` +
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('facilitator-spend-guard'))");
      const halted = await client.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_KEY]);
      if (halted.rows[0]) {
        await client.query('ROLLBACK');
        throw new FacilitatorHalted(
          `facilitator signing is halted (since ${halted.rows[0].value}) pending manual review -- ` +
            'see GET /admin/facilitator/status, resume via POST /admin/facilitator/resume',
        );
      }

      const spendResult = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM facilitator_spend_log WHERE created_at >= date_trunc('day', NOW())`,
      );
      const spentToday = Number(spendResult.rows[0].total);
      const cap = dailyCapUsdc();
      if (spentToday + amountUsdc > cap) {
        await this.halt(
          client,
          `daily cap exceeded: attempted $${amountUsdc} (${operation}${reference ? ` ${reference}` : ''}) ` +
            `with $${spentToday} already spent today against a $${cap} cap`,
        );
        await client.query('COMMIT');
        transactionOpen = false;
          `daily cap exceeded: attempted $${amountUsdc} (${operation}${reference ? ` ${reference}` : ''}) ` +
            `with $${spentToday} already spent today against a $${cap} cap`,
          client,
        );
        await client.query('COMMIT');
        throw new FacilitatorSpendCapExceeded(
          `signing this $${amountUsdc} ${operation} would exceed the daily cap of $${cap} ` +
            `($${spentToday} already spent today) -- halting further signing pending manual review`,
        );
      }

      await client.query('INSERT INTO facilitator_spend_log (amount_usdc, operation, reference) VALUES ($1, $2, $3)', [
        amountUsdc,
        operation,
        reference ?? null,
      ]);
      await client.query('COMMIT');
      transactionOpen = false;
    } catch (err) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof FacilitatorHalted || err instanceof FacilitatorSpendCapExceeded) throw err;
      throw new Error(`facilitator spend guard: could not read or record spend state, refusing to sign (fail closed): ${err}`);
    } finally {
      client.release();
    }
  }

  private async halt(client: PoolClient, reason: string): Promise<void> {
    this.logger.error(`HALTING facilitator signing: ${reason}`);
    await client.query(
      `INSERT INTO facilitator_state (key, value) VALUES ($1, NOW()::text)
       ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()`,
      [HALT_KEY],
    );
    await client.query(
      `INSERT INTO facilitator_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [HALT_REASON_KEY, reason],
    );
  }

  async status(): Promise<{ halted: boolean; haltedAt: string | null; haltReason: string | null; spentTodayUsdc: number; capUsdc: number }> {
    const [haltedAt, reason, spend] = await Promise.all([
      pool.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_KEY]),
      pool.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_REASON_KEY]),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM facilitator_spend_log WHERE created_at >= date_trunc('day', NOW())`,
      ),
    ]);
    return {
      halted: haltedAt.rows.length > 0,
      haltedAt: haltedAt.rows[0]?.value ?? null,
      haltReason: reason.rows[0]?.value ?? null,
      spentTodayUsdc: Number(spend.rows[0].total),
      capUsdc: dailyCapUsdc(),
    };
  }

  /** Explicit admin action only -- see the module comment for why this
   * never clears itself. */
  async resume(): Promise<{ haltedAt: string | null; haltReason: string | null; capUsdc: number; spentTodayUsdc: number }> {
    // RETURNING captures exactly what this DELETE cleared, so the caller can
    // put it in the audit log -- otherwise the halt reason is gone for good.
    const [cleared, spend] = await Promise.all([
      pool.query<{ key: string; value: string }>(
        'DELETE FROM facilitator_state WHERE key IN ($1, $2) RETURNING key, value',
        [HALT_KEY, HALT_REASON_KEY],
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM facilitator_spend_log WHERE created_at >= date_trunc('day', NOW())`,
      ),
    ]);
    const byKey = new Map(cleared.rows.map((r) => [r.key, r.value]));
    return {
      haltedAt: byKey.get(HALT_KEY) ?? null,
      haltReason: byKey.get(HALT_REASON_KEY) ?? null,
      capUsdc: dailyCapUsdc(),
      spentTodayUsdc: Number(spend.rows[0].total),
    };
  }
}
