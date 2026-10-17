import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { SessionsService } from './sessions.service';

const reserveSchema = z.object({
  muxed_id: z.string().regex(/^\d+$/, 'must be a stringified u64'),
});

@Controller('links/:linkId/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  // Unauthenticated public write — tighter than the global default (60/min)
  // to match the pattern for other public state-changing routes in this
  // codebase. Each call inserts a link_sessions row, so an unlimited rate
  // from a known linkId (pay links are public) is an easy DB-write amplifier.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  reserve(
    @Param('linkId') linkId: string,
    @Body(new ZodValidationPipe(reserveSchema)) body: z.infer<typeof reserveSchema>,
  ) {
    return this.sessions.reserve(linkId, body.muxed_id);
  }

  // The checkout page's confirmation poll. The payer's random muxed_id is
  // the capability: only the person who reserved it can read this, and it
  // returns only that one payment. Replaces scanning a merchant's whole
  // history for a match.
  @Get(':muxedId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  status(@Param('linkId') linkId: string, @Param('muxedId') muxedId: string) {
    if (!/^\d+$/.test(muxedId)) throw new BadRequestException('muxedId must be a stringified u64');
    return this.sessions.statusFor(linkId, muxedId);
  }
}
