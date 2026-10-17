import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { pool } from '../db/pool';
import { WithdrawalsService } from './withdrawals.service';

const tokenSchema = z.object({ transaction: z.string().min(1) });
const startSchema = z.object({ currency: z.enum(['XLM', 'USDC']), token: z.string().min(1) });
const prepareSchema = z.object({
  currency: z.enum(['XLM', 'USDC']),
  token: z.string().min(1),
  id: z.string().min(1),
});

// The account a cash-out moves from is always the logged-in merchant's own
// registered address — never a client-supplied field, for the same reason
// links.controller.ts stopped trusting a client-supplied merchant_id.
//
// Every method here calls out to the external anchor (testanchor.stellar.org)
// — a controller-wide throttle is simpler than tuning each one, and there's
// no legitimate reason a real cash-out flow needs more than this per minute.
@Controller('withdrawals')
@UseGuards(AuthGuard)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  // Every endpoint that acts on the merchant's account goes through this, so
  // none of them can be called directly to get past the missing-address case.
  private requireStellarAddress(req: AuthedRequest): string {
    const address = req.merchant.stellar_base_address;
    if (!address) {
      throw new BadRequestException('no Stellar address on file for this account');
    }
    return address;
  }

  @Get('challenge')
  challenge(@Req() req: AuthedRequest) {
    return this.withdrawals.getChallenge(this.requireStellarAddress(req));
  }

  @Post('token')
  token(@Body(new ZodValidationPipe(tokenSchema)) body: z.infer<typeof tokenSchema>) {
    return this.withdrawals.exchangeToken(body.transaction);
  }

  @Post('start')
  async start(@Body(new ZodValidationPipe(startSchema)) body: z.infer<typeof startSchema>, @Req() req: AuthedRequest) {
    const result = await this.withdrawals.startWithdrawal(body.token, body.currency, this.requireStellarAddress(req));
    // Best-effort — this is purely an admin-visibility record, and a
    // tracking-insert failure must never block the merchant's actual
    // cash-out, which has already succeeded on the anchor's side by now.
    try {
      await pool.query(
        `INSERT INTO withdrawal_attempts (merchant_id, currency, anchor_tx_id, token) VALUES ($1, $2, $3, $4)`,
        [req.merchant.id, body.currency, result.id, body.token],
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[withdrawals] could not record admin-visibility tracking row', err);
    }
    return result;
  }

  // Polled every 3s for the duration of an in-progress cash-out (which can
  // take minutes if the anchor's popup is slow) — the controller's default
  // 20/min would be right at that boundary, so this gets its own headroom.
  @Get('status')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  status(@Query('token') token: string, @Query('id') id: string) {
    if (!token || !id) throw new BadRequestException('token and id are both required');
    return this.withdrawals.getStatus(token, id);
  }

  @Post('prepare-payment')
  async preparePayment(
    @Body(new ZodValidationPipe(prepareSchema)) body: z.infer<typeof prepareSchema>,
    @Req() req: AuthedRequest,
  ) {
    const address = this.requireStellarAddress(req);
    const txn = await this.withdrawals.getStatus(body.token, body.id);
    return this.withdrawals.prepareWithdrawalTx(address, body.currency, txn);
  }
}
