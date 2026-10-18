import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { pool } from '../db/pool';
import { claimPayload } from '../common/channel-claim';
import { concurrentCalls } from '../../test/helpers/concurrent';
import { ChannelService } from './channel.service';

// Real Postgres (konfirm_test, see test/env.ts) and real Ed25519 signatures.
// claim() makes no RPC call, so nothing here touches the network.
describe('ChannelService.claim() (Postgres)', () => {
  const channel = new ChannelService();
  const channelIds: string[] = [];

  // Raw 32-byte public key, the form x402_channels.payer_pubkey stores (hex).
  function rawPublicKey(publicKey: KeyObject): Buffer {
    return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  }

  async function seedChannel(payerPubkey: Buffer, deposited: bigint): Promise<bigint> {
    // Random, and far above anything a real testnet channel id would reach.
    const onchainChannelId = 9_000_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000));
    await pool.query(
      `INSERT INTO x402_channels (onchain_channel_id, payer_address, payee_address, asset_contract, payer_pubkey, deposited)
       VALUES ($1, 'GPAYER', 'GPAYEE', 'CASSET', $2, $3)`,
      [onchainChannelId.toString(), payerPubkey.toString('hex'), deposited.toString()],
    );
    channelIds.push(onchainChannelId.toString());
    return onchainChannelId;
  }

  afterAll(async () => {
    if (channelIds.length > 0) {
      await pool.query('DELETE FROM x402_channels WHERE onchain_channel_id = ANY($1::bigint[])', [channelIds]);
    }
    await pool.end();
  });

  it('keeps the highest claim when many valid claims race', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const onchainChannelId = await seedChannel(rawPublicKey(publicKey), 1_000_000_000n);
    const claims = Array.from({ length: 30 }, (_, index) => {
      const nonce = BigInt(index + 1);
      const cumulativeAmount = nonce * 1_000n;
      return { nonce, cumulativeAmount, signature: sign(null, claimPayload(onchainChannelId, nonce, cumulativeAmount), privateKey) };
    });

    const results = await concurrentCalls(claims.length, (index) => channel.claim({ onchainChannelId, ...claims[index] }));

    // A claim that lost the race is reported stale, never silently accepted.
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled' && !result.value.accepted) expect(result.value.reason).toBe('stale_claim');
    }
    // Nothing is newer than the last claim, so it can never lose.
    const last = results[results.length - 1];
    expect(last.status === 'fulfilled' && last.value.accepted).toBe(true);

    const { rows } = await pool.query(
      'SELECT pending_nonce::text, pending_amount::text, pending_signature FROM x402_channels WHERE onchain_channel_id = $1',
      [onchainChannelId.toString()],
    );
    expect(rows[0]).toEqual({
      pending_nonce: '30',
      pending_amount: '30000',
      pending_signature: claims[claims.length - 1].signature.toString('hex'),
    });
  });

  it('rejects a lower claim arriving after a higher one', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const onchainChannelId = await seedChannel(rawPublicKey(publicKey), 1_000_000n);
    const signed = (nonce: bigint, cumulativeAmount: bigint) => ({
      onchainChannelId,
      nonce,
      cumulativeAmount,
      signature: sign(null, claimPayload(onchainChannelId, nonce, cumulativeAmount), privateKey),
    });

    await expect(channel.claim(signed(5n, 500n))).resolves.toEqual({ accepted: true });
    await expect(channel.claim(signed(4n, 400n))).resolves.toEqual({ accepted: false, reason: 'stale_claim' });
  });
});
