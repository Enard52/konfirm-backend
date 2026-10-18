import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Account, Keypair } from '@stellar/stellar-sdk';
import { FeesService, totalsByAsset } from './fees.service';
import { fromStroops, toStroops } from '../common/money-rules';
import { pool } from '../db/pool';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';

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

// Real Postgres (konfirm_test, see test/env.ts). Only the Horizon calls are
// stubbed, so nothing here touches the network.
describe('fee settlements (Postgres)', () => {
  const merchantIds: string[] = [];
  let nextMuxedId = 1;

  async function seedMerchant(stellarAddress: string | null = null): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO merchants (id, email, password_hash, name, stellar_base_address) VALUES ($1, $2, 'test', 'test', $3)`,
      [id, `${id}@example.test`, stellarAddress],
    );
    merchantIds.push(id);
    return id;
  }

  async function seedPayment(
    merchantId: string,
    feeOwed: string,
    feeStatus = 'owed',
    settlementId: string | null = null,
  ): Promise<string> {
    const token = randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO payments (
         merchant_id, muxed_id, muxed_address, payer_address, asset_code,
         amount_usdc, net_usdc, paging_token, tx_hash, ledger_sequence,
         fee_status, fee_owed_raw, fee_asset_code, fee_settlement_id
       ) VALUES ($1, $2, 'muxed', 'payer', 'XLM', 1, 1, $3, $4, 1, $5, $6, 'XLM', $7)
       RETURNING id`,
      [merchantId, nextMuxedId++, `paging-${token}`, `payment-${token}`, feeStatus, feeOwed, settlementId],
    );
    return rows[0].id;
  }

  async function seedSettlement(merchantId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO fee_settlements (id, merchant_id, tx_hash, unsigned_xdr, expires_at)
       VALUES ($1, $2, $3, 'test', NOW() + INTERVAL '1 hour')`,
      [id, merchantId, id.replace(/-/g, '')],
    );
    return id;
  }

  // A pending settlement with one claimed payment, as createSettlement()
  // leaves it.
  async function seedClaimedSettlement(feeOwed = '1.0000000') {
    const merchantId = await seedMerchant();
    const settlementId = await seedSettlement(merchantId);
    const paymentId = await seedPayment(merchantId, feeOwed, 'claimed', settlementId);
    await pool.query('INSERT INTO fee_settlement_items (settlement_id, payment_id, amount) VALUES ($1, $2, $3)', [
      settlementId,
      paymentId,
      feeOwed,
    ]);
    return { merchantId, settlementId, paymentId };
  }

  async function stateOf(settlementId: string, paymentId: string) {
    const { rows } = await pool.query(
      `SELECT s.status, s.confirmed_at, p.fee_status, p.fee_owed_raw::text, p.fee_settlement_id
       FROM fee_settlements s, payments p
       WHERE s.id = $1 AND p.id = $2`,
      [settlementId, paymentId],
    );
    return rows[0];
  }

  // Every client checked out of the pool fails statements matching `failOn`
  // until the returned function is called.
  function failPooledStatements(failOn: RegExp): () => void {
    const originalConnect = pool.connect;
    const realConnect = pool.connect.bind(pool);
    const restores: Array<() => void> = [];
    pool.connect = (async () => {
      const client = await realConnect();
      const realQuery = client.query;
      client.query = ((text: unknown, ...rest: unknown[]) => {
        if (typeof text === 'string' && failOn.test(text)) return Promise.reject(new Error('simulated failure'));
        return (realQuery as (...args: unknown[]) => unknown).call(client, text, ...rest);
      }) as unknown as typeof client.query;
      restores.push(() => {
        client.query = realQuery;
      });
      return client;
    }) as typeof pool.connect;
    return () => {
      for (const restore of restores) restore();
      pool.connect = originalConnect;
    };
  }

  afterEach(async () => {
    if (merchantIds.length === 0) return;
    const ids = merchantIds.splice(0);
    await pool.query('DELETE FROM payments WHERE merchant_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM fee_settlements WHERE merchant_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM merchants WHERE id = ANY($1::uuid[])', [ids]);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('createSettlement()', () => {
    it('claims each owed payment exactly once when two requests race', async () => {
      const fees = new FeesService();
      const merchantId = await seedMerchant(Keypair.random().publicKey());
      const paymentIds = [await seedPayment(merchantId, '0.5000000'), await seedPayment(merchantId, '0.2500000')];
      jest
        .spyOn((fees as any).horizon, 'loadAccount')
        .mockImplementation(async (address: any) => new Account(address, '1'));

      const results = await Promise.allSettled([fees.createSettlement(merchantId), fees.createSettlement(merchantId)]);

      const settlements = await pool.query('SELECT id FROM fee_settlements WHERE merchant_id = $1', [merchantId]);
      expect(settlements.rows).toHaveLength(1);
      const settlementId = settlements.rows[0].id;
      // The loser either finds nothing left to claim, or (if it ran after the
      // winner committed) gets the winner's settlement back.
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const r of results) {
        if (r.status === 'fulfilled') expect(r.value.settlement_id).toBe(settlementId);
        else expect(r.reason).toBeInstanceOf(NotFoundException);
      }

      const items = await pool.query(
        `SELECT payment_id, COUNT(*)::int AS n FROM fee_settlement_items
         WHERE payment_id = ANY($1::uuid[]) GROUP BY payment_id`,
        [paymentIds],
      );
      expect(items.rows).toHaveLength(2);
      expect(items.rows.every((row) => row.n === 1)).toBe(true);
      const claimed = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payments WHERE id = ANY($1::uuid[]) AND fee_status = 'claimed' AND fee_settlement_id = $2`,
        [paymentIds, settlementId],
      );
      expect(claimed.rows[0].n).toBe(2);
    });
  });

  describe('submitSigned()', () => {
    it('rejects malformed XDR with a 400 and leaves the settlement pending', async () => {
      const fees = new FeesService();
      const { merchantId, settlementId, paymentId } = await seedClaimedSettlement();
      const submit = jest.spyOn((fees as any).horizon, 'submitTransaction');

      const attempt = fees.submitSigned(merchantId, settlementId, 'this is not a transaction');
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow('malformed signed transaction');

      expect(submit).not.toHaveBeenCalled();
      const state = await stateOf(settlementId, paymentId);
      expect(state).toMatchObject({ status: 'pending', fee_status: 'claimed' });
      const { rows } = await pool.query('SELECT submission_error FROM fee_settlements WHERE id = $1', [settlementId]);
      expect(rows[0].submission_error).toBeNull();
    });
  });

  describe('confirm()', () => {
    it('rolls back the settlement update when the payments update fails', async () => {
      const fees = new FeesService();
      const { settlementId, paymentId } = await seedClaimedSettlement('1.0000000');

      const restore = failPooledStatements(/^\s*UPDATE payments\b/);
      try {
        await expect((fees as any).confirm(settlementId)).rejects.toThrow('simulated failure');
      } finally {
        restore();
      }

      // Without the transaction, the settlement would be confirmed here while
      // its payment stayed claimed forever.
      expect(await stateOf(settlementId, paymentId)).toMatchObject({
        status: 'pending',
        confirmed_at: null,
        fee_status: 'claimed',
        fee_owed_raw: '1.0000000',
        fee_settlement_id: settlementId,
      });

      // Nothing is stuck: a retry once the fault clears completes both updates.
      await (fees as any).confirm(settlementId);
      expect(await stateOf(settlementId, paymentId)).toMatchObject({
        status: 'confirmed',
        fee_status: 'settled',
        fee_owed_raw: '0.0000000',
        fee_settlement_id: settlementId,
      });
    });

    it('returns a partially settled payment to owed for the remainder', async () => {
      const fees = new FeesService();
      const merchantId = await seedMerchant();
      const settlementId = await seedSettlement(merchantId);
      const paymentId = await seedPayment(merchantId, '1.0000000', 'claimed', settlementId);
      await pool.query('INSERT INTO fee_settlement_items (settlement_id, payment_id, amount) VALUES ($1, $2, $3)', [
        settlementId,
        paymentId,
        '0.4000000',
      ]);

      await (fees as any).confirm(settlementId);

      expect(await stateOf(settlementId, paymentId)).toMatchObject({
        status: 'confirmed',
        fee_status: 'owed',
        fee_owed_raw: '0.6000000',
        fee_settlement_id: null,
      });
    });

    it('stays consistent when it races release() for the same settlement', async () => {
      const fees = new FeesService();
      const { settlementId, paymentId } = await seedClaimedSettlement();

      await Promise.all([(fees as any).confirm(settlementId), (fees as any).release(settlementId)]);

      const state = await stateOf(settlementId, paymentId);
      expect(
        (state.status === 'confirmed' && state.fee_status === 'settled') ||
          (state.status === 'expired' && state.fee_status === 'owed'),
      ).toBe(true);
    });
  });

  describe('sweepPending()', () => {
    it('never runs two sweeps at once', async () => {
      const fees = new FeesService();
      const merchantId = await seedMerchant();
      // Gives the first sweep something to look up, so it holds the lock.
      await seedSettlement(merchantId);

      let firstLookupStarted!: () => void;
      const started = new Promise<void>((resolve) => (firstLookupStarted = resolve));
      let unblockLookups!: () => void;
      const unblocked = new Promise<void>((resolve) => (unblockLookups = resolve));
      const lookup = jest.spyOn(fees as any, 'lookup').mockImplementation(async () => {
        firstLookupStarted();
        await unblocked;
        return null;
      });

      try {
        const first = fees.sweepPending();
        await started;

        // The first sweep is parked inside lookup(), holding the lock.
        await expect(fees.sweepPending()).resolves.toEqual({ confirmed: 0, expired: 0 });
        expect(lookup).toHaveBeenCalledTimes(1);

        unblockLookups();
        await first;

        // The lock was released: a later sweep runs normally.
        const callsBefore = lookup.mock.calls.length;
        await fees.sweepPending();
        expect(lookup.mock.calls.length).toBeGreaterThan(callsBefore);
      } finally {
        unblockLookups();
        lookup.mockRestore();
      }
    });
  });
});
