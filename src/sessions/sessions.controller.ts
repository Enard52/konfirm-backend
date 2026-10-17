import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { nonNegativeIntegerStringSchema, POSTGRES_BIGINT_MAX } from '../common/numeric-validation';
import { SessionsService } from './sessions.service';

const muxedIdSchema = nonNegativeIntegerStringSchema(POSTGRES_BIGINT_MAX, 'muxed_id');
const reserveSchema = z.object({
  muxed_id: muxedIdSchema,
});

@Controller('links/:linkId/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

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
    if (!muxedIdSchema.safeParse(muxedId).success) {
      throw new BadRequestException('muxedId must fit in a non-negative signed 64-bit integer');
    }
    return this.sessions.statusFor(linkId, muxedId);
  }
}
