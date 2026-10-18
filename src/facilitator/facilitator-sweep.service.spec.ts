import { Client } from '@stellar/stellar-sdk/contract';
import { pool } from '../db/pool';
import { TREASURY_CONTRACT_ID } from '../common/stellar-network';
import { FacilitatorSweepService } from './facilitator-sweep.service';
import { FacilitatorSpendCapExceeded, type FacilitatorSpendGuardService } from './facilitator-spend-guard.service';

// The advisory lock runs against real Postgres (konfirm_test, see
// test/env.ts). The USDC balance read, the signer and the transfer itself
// are stubbed, so nothing here touches the network.
jest.mock('@stellar/stellar-sdk/contract', () => {
  const original = jest.requireActual('@stellar/stellar-sdk/contract');
  return { ...original, Client: { ...original.Client, from: jest.fn() } };
});

jest.mock('../common/facilitator-signer', () => ({
  getFacilitatorSigner: jest.fn().mockResolvedValue({ address: 'GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB' }),
  withFacilitatorSubmissionLock: jest.fn((fn: () => Promise<unknown>) => fn()),
}));

// Must match SWEEP_LOCK_KEY in facilitator-sweep.service.ts.
const SWEEP_LOCK_KEY = 402_002;

describe('FacilitatorSweepService', () => {
  const usdc = { balance: jest.fn() };
  const spendGuard = { checkAndRecordSpend: jest.fn() };
  const service = new FacilitatorSweepService(spendGuard as unknown as FacilitatorSpendGuardService);
  const originalMin = process.env.FACILITATOR_SWEEP_MIN_USDC_BALANCE;
  let submitTransfer: jest.SpyInstance;

  beforeEach(() => {
    (Client.from as jest.Mock).mockResolvedValue(usdc);
    usdc.balance.mockReset();
    spendGuard.checkAndRecordSpend.mockReset().mockResolvedValue(undefined);
    submitTransfer = jest.spyOn(service as any, 'submitTransfer').mockResolvedValue({ success: true, transaction: 'tx-hash' });
    process.env.FACILITATOR_SWEEP_MIN_USDC_BALANCE = '1';
  });

  afterEach(() => {
    submitTransfer.mockRestore();
    if (originalMin === undefined) delete process.env.FACILITATOR_SWEEP_MIN_USDC_BALANCE;
    else process.env.FACILITATOR_SWEEP_MIN_USDC_BALANCE = originalMin;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('does nothing when no minimum balance is configured', async () => {
    delete process.env.FACILITATOR_SWEEP_MIN_USDC_BALANCE;
    await service.sweep();
    expect(usdc.balance).not.toHaveBeenCalled();
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('skips the run while another sweep holds the lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [SWEEP_LOCK_KEY]);
      await service.sweep();
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]);
      holder.release();
    }
    expect(usdc.balance).not.toHaveBeenCalled();
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  it('moves nothing when the balance is at or below the minimum', async () => {
    usdc.balance.mockResolvedValue({ result: 10_000_000n }); // exactly 1 USDC
    await service.sweep();
    expect(submitTransfer).not.toHaveBeenCalled();
    expect(spendGuard.checkAndRecordSpend).not.toHaveBeenCalled();
  });

  it('records no spend when the transfer fails', async () => {
    usdc.balance.mockResolvedValue({ result: 35_000_000n });
    submitTransfer.mockResolvedValue({ success: false, errorReason: 'sweep_submission_failed' });
    await service.sweep();
    expect(submitTransfer).toHaveBeenCalledWith(expect.any(String), 25_000_000n);
    expect(spendGuard.checkAndRecordSpend).not.toHaveBeenCalled();
  });

  it('sweeps everything above the minimum and records it as spend', async () => {
    usdc.balance.mockResolvedValue({ result: 35_000_000n });
    await service.sweep();
    expect(submitTransfer).toHaveBeenCalledWith(expect.any(String), 25_000_000n);
    expect(spendGuard.checkAndRecordSpend).toHaveBeenCalledWith(2.5, 'sweep', TREASURY_CONTRACT_ID);
  });

  it('does not throw when the guard rejects recording a transfer that already landed', async () => {
    usdc.balance.mockResolvedValue({ result: 35_000_000n });
    spendGuard.checkAndRecordSpend.mockRejectedValue(new FacilitatorSpendCapExceeded('over cap'));
    await expect(service.sweep()).resolves.toBeUndefined();
    expect(submitTransfer).toHaveBeenCalled();
  });
});
