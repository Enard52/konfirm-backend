import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Asset, BASE_FEE, Horizon, Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { pool } from '../db/pool';
import { platformFeeAddress } from '../common/platform-fee';
import { HORIZON_URL, NETWORK_PASSPHRASE } from '../common/stellar-network';
import { fromStroops, toStroops } from '../common/money-rules';

// Owed platform fees (docs/design/qr-fee-collection.md, Option B). A payer who
// pays a link by QR pays the link amount only, so the fee is recorded as owed.
// The merchant clears it by signing one transaction from their own account to
// the fee account. Konfirm builds that transaction and submits what the
// merchant signed, but never holds the merchant's key.
//
// Lifecycle: a payment's fee goes owed -> claimed (in a pending settlement the
// merchant hasn't signed yet) -> settled (the settlement is on-chain). A
// settlement that expires unsigned releases its claims back to owed.

const SETTLEMENT_TTL_SECONDS = 15 * 60;
const SETTLEMENT_MEMO = 'Konfirm fees';

export interface OwedTotal {
  asset_code: string;
  asset_issuer: string | null;
  amount: string;
  payments: number;
}

export interface SettlementSelection {
  amount: string;
  asset_code: string;
  asset_issuer?: string | null;
}

interface PaymentFeeRow {
  id: string;
  fee_owed_raw: string;
  fee_asset_code: string;
  fee_asset_issuer: string | null;
}

// Builds the Stellar asset for a stored fee. Native XLM has no issuer.
export function assetFor(code: string, issuer: string | null): Asset {
  return code === 'XLM' ? Asset.native() : new Asset(code, issuer as string);
}

// Sums owed fees per asset. Pure, so the arithmetic is tested directly.
export function totalsByAsset(rows: PaymentFeeRow[]): Array<{ code: string; issuer: string | null; amount: string; payments: number }> {
  const byKey = new Map<string, { code: string; issuer: string | null; sum: bigint; payments: number }>();
  for (const r of rows) {
    const key = `${r.fee_asset_code}:${r.fee_asset_issuer ?? ''}`;
    const stroops = toStroops(r.fee_owed_raw);
    const existing = byKey.get(key) ?? { code: r.fee_asset_code, issuer: r.fee_asset_issuer, sum: 0n, payments: 0 };
    existing.sum += stroops;
    existing.payments += 1;
    byKey.set(key, existing);
  }
  return [...byKey.values()].map((v) => ({ code: v.code, issuer: v.issuer, amount: fromStroops(v.sum), payments: v.payments }));
}

@Injectable()
export class FeesService {
  private readonly logger = new Logger(FeesService.name);
  private readonly horizon = new Horizon.Server(HORIZON_URL);

  async owed(merchantId: string): Promise<{ totals: OwedTotal[]; payments: number }> {
    const { rows } = await pool.query<PaymentFeeRow>(
      `SELECT id, fee_owed_raw::text, fee_asset_code, fee_asset_issuer
       FROM payments WHERE merchant_id = $1 AND fee_status = 'owed' AND status = 'paid'`,
      [merchantId],
    );
    const totals = totalsByAsset(rows).map((t) => ({
      asset_code: t.code,
      asset_issuer: t.issuer,
      amount: t.amount,
      payments: t.payments,
    }));
    return { totals, payments: rows.length };
  }

  // Builds a settlement for all owed fees, or a requested portion of one asset.
  async createSettlement(merchantId: string, selection?: SettlementSelection) {
    const merchantRes = await pool.query('SELECT stellar_base_address FROM merchants WHERE id = $1', [merchantId]);
    const merchantAddress: string | null = merchantRes.rows[0]?.stellar_base_address ?? null;
    if (!merchantAddress) throw new BadRequestException('add a Stellar address to your account before settling fees');

    const existing = await pool.query(
      `SELECT id, unsigned_xdr, expires_at FROM fee_settlements
       WHERE merchant_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [merchantId],
    );
    if (existing.rows[0]) {
      const s = existing.rows[0];
      return this.describeSettlement(s.id, s.unsigned_xdr, s.expires_at, merchantId);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One settlement build per merchant at a time, so two requests can't both
      // claim the same owed payments.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fees:${merchantId}`]);
      const { rows } = await client.query<PaymentFeeRow>(
        `SELECT id, fee_owed_raw::text, fee_asset_code, fee_asset_issuer
         FROM payments WHERE merchant_id = $1 AND fee_status = 'owed' AND status = 'paid'
         ORDER BY created_at, id
         FOR UPDATE`,
        [merchantId],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundException('no fees are owed');
      }

      let selectedRows = rows;
      let remaining = selection ? toStroops(selection.amount) : null;
      if (selection) {
        if (remaining! <= 0n) throw new BadRequestException('settlement amount must be greater than zero');
        selectedRows = rows.filter((row) => row.fee_asset_code === selection.asset_code);
        if (selection.asset_issuer !== undefined) {
          selectedRows = selectedRows.filter((row) => row.fee_asset_issuer === selection.asset_issuer);
        } else if (selection.asset_code === 'XLM') {
          selectedRows = selectedRows.filter((row) => row.fee_asset_issuer === null);
        } else if (new Set(selectedRows.map((row) => row.fee_asset_issuer)).size > 1) {
          throw new BadRequestException('specify the asset issuer to settle this asset');
        }
        const available = selectedRows.reduce((sum, row) => sum + toStroops(row.fee_owed_raw), 0n);
        if (remaining > available) throw new BadRequestException('settlement amount exceeds the amount owed for this asset');
      }

      const allocations: Array<{ row: PaymentFeeRow; amount: bigint }> = [];
      for (const row of selectedRows) {
        if (remaining !== null && remaining === 0n) break;
        const owed = toStroops(row.fee_owed_raw);
        const amount = remaining === null || remaining > owed ? owed : remaining;
        if (amount > 0n) allocations.push({ row, amount });
        if (remaining !== null) remaining -= amount;
      }
      if (allocations.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundException('no fees are owed for this asset');
      }

      const totals = totalsByAsset(allocations.map(({ row, amount }) => ({ ...row, fee_owed_raw: fromStroops(amount) })));
      const builder = await this.buildUnsigned(merchantAddress, totals);
      const tx = builder.build();
      const expiresAt = new Date((tx.timeBounds ? Number(tx.timeBounds.maxTime) : Math.floor(Date.now() / 1000) + SETTLEMENT_TTL_SECONDS) * 1000);
      const unsignedXdr = tx.toXDR();
      const txHash = Buffer.from(tx.hash()).toString('hex');

      const ins = await client.query(
        `INSERT INTO fee_settlements (merchant_id, tx_hash, unsigned_xdr, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [merchantId, txHash, unsignedXdr, expiresAt],
      );
      const settlementId = ins.rows[0].id;
      await client.query(
        `INSERT INTO fee_settlement_items (settlement_id, payment_id, amount)
         SELECT $1, payment_id, amount::numeric
         FROM unnest($2::uuid[], $3::text[]) AS allocation(payment_id, amount)`,
        [settlementId, allocations.map(({ row }) => row.id), allocations.map(({ amount }) => fromStroops(amount))],
      );
      await client.query(
        `UPDATE payments SET fee_status = 'claimed', fee_settlement_id = $2
         WHERE id = ANY($1::uuid[])`,
        [allocations.map(({ row }) => row.id), settlementId],
      );
      await client.query('COMMIT');
      return this.describeSettlement(settlementId, unsignedXdr, expiresAt, merchantId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Submits the merchant-signed settlement transaction to Horizon.
  async submitSigned(merchantId: string, settlementId: string, signedXdr: string) {
    const res = await pool.query(
      `SELECT id, status, expires_at FROM fee_settlements WHERE id = $1 AND merchant_id = $2`,
      [settlementId, merchantId],
    );
    const settlement = res.rows[0];
    if (!settlement) throw new NotFoundException('settlement not found');
    if (settlement.status !== 'pending') throw new ConflictException('settlement is not pending');
    if (new Date(settlement.expires_at) <= new Date()) throw new BadRequestException('settlement has expired');

    let tx;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    } catch {
      throw new BadRequestException('malformed signed transaction');
    }
    await this.confirm(settlementId);
    return { ok: true, settlement_id: settlementId, tx_hash: s.tx_hash };
  }

  private async confirm(settlementId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE fee_settlements SET status = 'confirmed', confirmed_at = NOW()
         WHERE id = $1 AND status = 'pending' RETURNING id`,
        [settlementId],
      );
      if (rowCount) {
        await client.query(
          `UPDATE payments SET fee_status = 'settled'
           WHERE fee_settlement_id = $1 AND fee_status = 'claimed'`,
          [settlementId],
        );
      }
  private async confirm(settlementId: string, client: { query: PoolClient['query'] } = pool) {
    const { rowCount } = await client.query(
      `UPDATE fee_settlements SET status = 'confirmed', confirmed_at = NOW(), submission_error = NULL
       WHERE id = $1 AND status = 'pending'`,
      [settlementId],
    );
    if (!rowCount) return;
    await client.query(
      `UPDATE payments p
       SET fee_owed_raw = p.fee_owed_raw - i.amount,
           fee_status = CASE WHEN p.fee_owed_raw - i.amount <= 0 THEN 'settled' ELSE 'owed' END,
           fee_settlement_id = NULL
       FROM fee_settlement_items i
       WHERE i.settlement_id = $1 AND p.id = i.payment_id AND p.fee_status = 'claimed'`,
      [settlementId],
    );
  }

    try {
      const result = await this.horizon.submitTransaction(tx as any);
      await pool.query(`UPDATE fee_settlements SET status = 'settled', tx_hash = $2 WHERE id = $1`, [settlementId, result.hash]);
      await pool.query(
        `UPDATE payments SET fee_status = 'settled'
         WHERE fee_settlement_id = $1`,
        [settlementId],
      );
      return { status: 'settled', tx_hash: result.hash };
    } catch (err: any) {
      this.logger.warn(`settlement ${settlementId} submission failed: ${err?.message ?? err}`);
      throw new BadRequestException('transaction submission failed');
    }
  }

  private async describeSettlement(id: string, unsignedXdr: string, expiresAt: Date, merchantId: string) {
    const { rows } = await pool.query(
      `SELECT i.payment_id, i.amount::text, p.fee_asset_code, p.fee_asset_issuer
       FROM fee_settlement_items i JOIN payments p ON p.id = i.payment_id
       WHERE i.settlement_id = $1`,
      [id],
    );
    let confirmed = 0;
    let expired = 0;
    for (const s of rows) {
      const onChain = await this.lookup(s.tx_hash);
      if (onChain?.successful) {
        await this.confirm(s.id);
        confirmed++;
        continue;
      }
      const pastExpiry = new Date(s.expires_at) <= new Date();
      // A failed on-chain record, or no record once the time bound has passed,
      // means the settlement can never land. Release its claims.
      if (onChain?.successful === false || (!onChain && pastExpiry)) {
        await this.release(s.id);
        expired++;
      }
    }
    if (confirmed || expired) this.logger.log(`fee settlements: ${confirmed} confirmed, ${expired} released`);
    return { confirmed, expired };
  }

  private async release(settlementId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE fee_settlements SET status = 'expired'
         WHERE id = $1 AND status = 'pending' RETURNING id`,
        [settlementId],
      );
      if (rowCount) {
        await client.query(
          `UPDATE payments SET fee_status = 'owed', fee_settlement_id = NULL
           WHERE fee_settlement_id = $1 AND fee_status = 'claimed'`,
          [settlementId],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async buildUnsigned(merchantAddress: string, totals: Array<{ code: string; issuer: string | null; amount: string }>) {
    const account = await this.horizon.loadAccount(merchantAddress);
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + SETTLEMENT_TTL_SECONDS },
    });
    for (const t of totals) {
      builder.addOperation(
        Operation.payment({
          destination: platformFeeAddress(),
          asset: assetFor(t.code, t.issuer),
          amount: t.amount,
        }),
      );
    }
    builder.addMemo(Memo.text(SETTLEMENT_MEMO));
    return builder;
  }
}
