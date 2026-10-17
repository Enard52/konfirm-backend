import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard, ADMIN_SESSION_COOKIE, AuthedAdminRequest } from './admin-auth.guard';

// Same 10/min rationale as auth.controller.ts's AUTH_THROTTLE.
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Deliberately no POST /admin/auth/signup — an internet-facing "create an
// admin account" endpoint is its own security problem. Admins are
// provisioned out-of-band via `npm run seed:admin` (see db/seed-admin.ts).
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, admin } = await this.adminAuth.login(body.email, body.password);
    this.setSessionCookie(res, token);
    return { admin };
  }

  // Revokes server-side as well as clearing the cookie — see auth.controller.ts.
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.adminAuth.logout(req.cookies?.[ADMIN_SESSION_COOKIE]);
    res.clearCookie(ADMIN_SESSION_COOKIE);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminGuard)
  me(@Req() req: AuthedAdminRequest) {
    return { admin: req.admin };
  }

  private setSessionCookie(res: Response, token: string) {
    res.cookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      // Stricter than the merchant cookie's 'lax' — this guards mutation of
      // other people's accounts, not just the admin's own session.
      sameSite: 'strict',
      // Same NODE_ENV-driven reasoning as the merchant cookie — see
      // auth.controller.ts's setSessionCookie.
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }
}
