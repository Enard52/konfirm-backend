import { FeesService, totalsByAsset } from './fees.service';
import { fromStroops, toStroops } from '../common/money-rules';
import { pool } from '../db/pool';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';

describe('fee arithmetic', () => {
  it('converts to stroops and back without drift', () => {
    expect(toStroops('0.1000000')).toBe(1_000_000n);
    expect(fromStroops(toStroops('12.3456789'))).toBe('12.3456789');
    expect(fromStroops(toStroops('0.0000001'))).toBe('0.0000001');
    expect(fromStroops(0n)).toBe('0.0000000');
  });

  it('sums many small fees exactly, where floats would drift', () => {
    // 0.1 + 0.2 is not 0.3 in binary floating point. Settlement must be exact.
    const rows = [
      { id: '1', fee_owed_raw: '0.1000000', fee_asset_code: 'XLM', fee_asset_issuer: null },
      { id: '2', fee_owed_raw: '0.2000000', fee_asset_code: 'XLM', fee_asset_issuer: null },
    ];
    expect(totalsByAsset(rows)).toEqual([{ code: 'XLM', issuer: null, amount: '0.3000000', payments: 2 }]);
  });

  it('keeps each asset and issuer separate', () => {
    const rows = [
      { id: '1', fee_owed_raw: '1.0000000', fee_asset_code: 'USDC', fee_asset_issuer: 'GISSUER' },
      { id: '2', fee_owed_raw: '2.0000000', fee_asset_code: 'USDC', fee_asset_issuer: 'GOTHER' },
      { id: '3', fee_owed_raw: '0.5000000', fee_asset_code: 'USDC', fee_asset_issuer: 'GISSUER' },
    ];
    const totals = totalsByAsset(rows);
    expect(totals).toHaveLength(2);
    expect(totals.find((t) => t.issuer === 'GISSUER')).toMatchObject({ amount: '1.5000000', payments: 2 });
    expect(totals.find((t) => t.issuer === 'GOTHER')).toMatchObject({ amount: '2.0000000', payments: 1 });
  });
});

describe('fee settlement concurrency (Postgres)', () => {
  it('keeps settlement and payment state consistent for concurrent conflicting sweep results', async () => {
    const fees = new FeesService();
    const merchantId = randomUUID();
    const settlementId = randomUUID();
    let lookupCount = 0;
    let releaseLookups!: () => void;
    const bothLookupsStarted = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });

    await pool.query(
      `INSERT INTO merchants (id, email, password_hash, name) VALUES ($1, $2, 'test', 'test')`,
      [merchantId, `${merchantId}@example.test`],
    );
    await pool.query(
      `INSERT INTO fee_settlements (id, merchant_id, tx_hash, unsigned_xdr, expires_at)
       VALUES ($1, $2, $3, 'test', NOW() + INTERVAL '1 hour')`,
      [settlementId, merchantId, settlementId.replace(/-/g, '')],
    );
    await pool.query(
      `INSERT INTO payments (
         merchant_id, muxed_id, muxed_address, payer_address, asset_code,
         amount_usdc, net_usdc, paging_token, tx_hash, ledger_sequence,
         fee_status, fee_settlement_id
       ) VALUES ($1, 1, 'muxed', 'payer', 'USDC', 1, 1, $2, $3, 1, 'claimed', $4)`,
      [merchantId, `paging-${settlementId}`, `payment-${settlementId}`, settlementId],
    );

    const lookup = jest.spyOn(fees as any, 'lookup').mockImplementation(async () => {
      const caller = ++lookupCount;
      if (lookupCount === 2) releaseLookups();
      await bothLookupsStarted;
      return caller === 1 ? { successful: true } : { successful: false };
    });

    try {
      await Promise.all([fees.sweepPending(), fees.sweepPending()]);
      const { rows } = await pool.query(
        `SELECT s.status, p.fee_status
         FROM fee_settlements s JOIN payments p ON p.merchant_id = s.merchant_id
         WHERE s.id = $1`,
        [settlementId],
      );
      expect(rows).toHaveLength(1);
      expect(
        (rows[0].status === 'confirmed' && rows[0].fee_status === 'settled') ||
          (rows[0].status === 'expired' && rows[0].fee_status === 'owed'),
      ).toBe(true);
    } finally {
      lookup.mockRestore();
      await pool.query('DELETE FROM payments WHERE merchant_id = $1', [merchantId]);
      await pool.query('DELETE FROM fee_settlements WHERE id = $1', [settlementId]);
      await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
    }
  });
});
