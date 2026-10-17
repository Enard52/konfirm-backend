import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { nonNegativeDecimalStringSchema } from '../common/numeric-validation';
import { LinksService } from './links.service';

// merchant_id is deliberately absent from this schema — it used to be a
// client-supplied field, which meant any caller who knew or guessed a UUID
// could create a Link against someone else's account. It now comes only
// from the authenticated session (req.merchant.id).
const createLinkSchema = z.object({
  amount_usdc: nonNegativeDecimalStringSchema('amount_usdc', 7, 999_999_999_999_999_999n).optional(),
  currency: z.enum(['USDC', 'EURC', 'XLM']).optional(),
  description: z.string().max(500).optional(),
  reusable: z.boolean().optional(),
});

@Controller('links')
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Post()
  @UseGuards(AuthGuard)
  create(
    @Body(new ZodValidationPipe(createLinkSchema)) body: z.infer<typeof createLinkSchema>,
    @Req() req: AuthedRequest,
  ) {
    return this.links.create({ ...body, merchant_id: req.merchant.id });
  }

  @Get(':id/public')
  getPublic(@Param('id') id: string) {
    return this.links.getPublic(id);
  }
}
