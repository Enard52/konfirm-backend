import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { FeesService } from './fees.service';

const submitSchema = z.object({
  signed_xdr: z.string().min(20).max(20_000),
});

const createSettlementSchema = z
  .object({
    amount: z.string().regex(/^\d+(\.\d{1,7})?$/).optional(),
    asset_code: z.enum(['XLM', 'USDC', 'EURC']).optional(),
    asset_issuer: z.string().nullable().optional(),
  })
  .refine((value) => (value.amount === undefined) === (value.asset_code === undefined), {
    message: 'amount and asset_code must be provided together',
  })
  .refine((value) => value.asset_issuer === undefined || value.amount !== undefined, {
    message: 'asset_issuer requires a partial settlement amount',
  })
  .optional();

// Merchant-facing fee settlement. Every route requires the merchant's session,
// and settlement ids are checked against the session's own merchant, so one
// merchant can't reach another's settlements.
@Controller('fees')
@UseGuards(AuthGuard)
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Get('owed')
  owed(@Req() req: AuthedRequest) {
    return this.fees.owed(req.merchant.id);
  }

  @Get('settlements')
  list(@Req() req: AuthedRequest) {
    return this.fees.listSettlements(req.merchant.id);
  }

  @Post('settlements')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(createSettlementSchema)) body: z.infer<typeof createSettlementSchema> = {},
  ) {
    const selection = body && body.amount !== undefined && body.asset_code !== undefined ? {
      amount: body.amount,
      asset_code: body.asset_code,
      asset_issuer: body.asset_issuer,
    } : undefined;
    return this.fees.createSettlement(req.merchant.id, selection);
  }

  @Post('settlements/:id/submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(submitSchema)) body: z.infer<typeof submitSchema>,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('invalid settlement id');
    return this.fees.submitSigned(req.merchant.id, id, body.signed_xdr);
  }

  @Post('settlements/:id/dispute')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  dispute(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('invalid settlement id');
    return this.fees.disputeSettlement(req.merchant.id, id);
  }
}
