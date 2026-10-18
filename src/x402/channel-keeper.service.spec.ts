import { pool } from '../db/pool';
import { ChannelKeeperService } from './channel-keeper.service';
import type { ChannelService } from './channel.service';

// Real Postgres (konfirm_test, see test/env.ts). Only the on-chain read is
// stubbed, so each case controls exactly what get_channel_info() returns.
describe('ChannelKeeperService.resyncFromChain() (Postgres)', () => {
  const getChannelInfoOnChain = jest.fn();
  const keeper = new ChannelKeeperService({ getChannelInfoOnChain } as unknown as ChannelService);
  const resync = (onchainChannelId: bigint): Promise<void> => (keeper as any).resyncFromChain(onchainChannelId);
  const channelIds: string[] = [];

  async function seedChannel(status = 'open'): Promise<bigint> {
    const onchainChannelId = 8_000_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000));
    await pool.query(
      `INSERT INTO x402_channels (onchain_channel_id, payer_address, payee_address, asset_contract, payer_pubkey, deposited, claimed, status)
       VALUES ($1, 'GPAYER', 'GPAYEE', 'CASSET', '00', 1000, 100, $2)`,
      [onchainChannelId.toString(), status],
    );
    channelIds.push(onchainChannelId.toString());
    return onchainChannelId;
  }

  async function rowOf(onchainChannelId: bigint) {
    const { rows } = await pool.query('SELECT claimed::text, status FROM x402_channels WHERE onchain_channel_id = $1', [
      onchainChannelId.toString(),
    ]);
    return rows[0];
  }

  beforeEach(() => {
    getChannelInfoOnChain.mockReset();
  });

  afterAll(async () => {
    if (channelIds.length > 0) {
      await pool.query('DELETE FROM x402_channels WHERE onchain_channel_id = ANY($1::bigint[])', [channelIds]);
    }
    await pool.end();
  });

  it('decodes a data-less enum variant returned as a one-element array', async () => {
    const id = await seedChannel('open');
    getChannelInfoOnChain.mockResolvedValue({ claimed: 250n, status: ['Closing'] });

    await resync(id);

    expect(await rowOf(id)).toEqual({ claimed: '250', status: 'closing' });
  });

  it('also accepts the status as a plain string', async () => {
    const id = await seedChannel('closing');
    getChannelInfoOnChain.mockResolvedValue({ claimed: 400n, status: 'Closed' });

    await resync(id);

    expect(await rowOf(id)).toEqual({ claimed: '400', status: 'closed' });
  });

  it('updates claimed but keeps the stored status for an unknown variant', async () => {
    const id = await seedChannel('open');
    getChannelInfoOnChain.mockResolvedValue({ claimed: 300n, status: ['SomethingNew'] });

    await resync(id);

    expect(await rowOf(id)).toEqual({ claimed: '300', status: 'open' });
  });

  it('swallows a failed on-chain read and heals on the next sweep', async () => {
    const id = await seedChannel('open');
    getChannelInfoOnChain.mockRejectedValueOnce(new Error('rpc unavailable'));

    // Never throws out of the sweep; the row is left as it was.
    await expect(resync(id)).resolves.toBeUndefined();
    expect(await rowOf(id)).toEqual({ claimed: '100', status: 'open' });

    // The next sweep retries and picks up on-chain truth.
    getChannelInfoOnChain.mockResolvedValueOnce({ claimed: 175n, status: ['Open'] });
    await resync(id);
    expect(await rowOf(id)).toEqual({ claimed: '175', status: 'open' });
    expect(getChannelInfoOnChain).toHaveBeenCalledTimes(2);
  });
});
