import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { LinksService } from './links.service';

// merchant_id is deliberately absent from this schema — it used to be a
// client-supplied field, which meant any caller who knew or guessed a UUID
// could create a Link against someone else's account. It now comes only
// from the authenticated session (req.merchant.id).
const createLinkSchema = z.object({
  amount_usdc: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/, 'must be a plain decimal string, 7dp max')
    .optional(),
  currency: z.enum(['USDC', 'EURC', 'XLM']).optional(),
  description: z.string().max(500).optional(),
  reusable: z.boolean().optional(),
  // Client-supplied. A retry with the same key returns the original link
  // instead of creating a second one (scoped per merchant).
  idempotency_key: z.string().min(1).max(255).optional(),
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
