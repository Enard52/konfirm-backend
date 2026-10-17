import { BazaarService } from '../src/bazaar/bazaar.service';
import { startInteractiveOnce } from '../src/common/anchor-start-dedup';
import { pool } from '../src/db/pool';

// Concurrent-duplicate protection, against real Postgres: the races these
// guard against only exist with a real lock and a real unique index.
describe('duplicate-request protection (e2e)', () => {
  const url = `https://example.com/race-${Date.now()}`;

  afterAll(async () => {
    await pool.query('DELETE FROM bazaar_listings WHERE url = $1', [url]);
    await pool.query("DELETE FROM anchor_interactive_sessions WHERE session->>'id' LIKE 'race-%'");
    await pool.end();
  });

  it('bazaar: two concurrent submissions for one URL insert exactly one row', async () => {
    const bazaar = new BazaarService();
    const input = { kind: 'resource' as const, url, description: 'a resource for the race test' };
    const results = await Promise.allSettled([bazaar.submit(input), bazaar.submit(input)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.getStatus()).toBe(409);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM bazaar_listings WHERE url = $1', [url]);
    expect(rows[0].n).toBe(1);
  });

  it.each(['withdraw', 'deposit'] as const)('%s/start: a repeated start calls the anchor once', async (direction) => {
    const anchorCall = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { id: `race-${direction}-${Date.now()}`, url: 'https://anchor.example/hosted' };
    });
    const token = `token-${direction}-${Date.now()}`;
    const start = () => startInteractiveOnce(direction, 'GACCOUNT', 'USDC', token, anchorCall);

    const [a, b] = await Promise.all([start(), start()]);
    const c = await start();

    expect(anchorCall).toHaveBeenCalledTimes(1);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
  });
});
