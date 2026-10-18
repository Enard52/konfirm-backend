import { Body, Controller, Get, HttpCode, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthService } from './auth.service';
import { AuthedRequest, AuthGuard, SESSION_COOKIE } from './auth.guard';
import { zodBody } from '../common/zod-to-openapi';

// Password-guessing and account-creation-spam both live here — 10/min per
// IP is generous for a real user, punishing for a script.
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
// Reset requests send real email, so they get a tighter ceiling than login.
const FORGOT_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

// bcrypt only uses the first 72 bytes of a password. Anything past that is
// ignored silently, so cap it here instead of letting users think a longer
// passphrase is stronger than it is. Counted in bytes, not characters.
const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'password must be 72 bytes or fewer');

// Emails are normalised to lowercase (see auth.service.ts normalizeEmail).
const emailSchema = z.string().trim().toLowerCase().email();

const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(1).max(200),
  // Stellar strkey account id — base32, no checksum validation here; a
  // malformed address fails loudly the first time a payout is attempted,
  // which is an acceptable place for that error to surface for a pilot.
  stellar_base_address: z.string().regex(/^G[A-Z2-7]{55}$/, 'must be a valid Stellar G... address'),
  // Optional -- an invalid/mistyped code never blocks signup, see
  // AuthService.signup(). Loosely validated here only to reject obviously
  // malformed input before it reaches a query.
  referral_code: z.string().max(20).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: emailSchema,
});

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

// 30 days, matching the JWT's own expiry in auth.service.ts.
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Create a merchant account',
    description:
      'Creates a new merchant and immediately issues a session cookie. ' +
      'Rate-limited to 10 req/min per IP.',
  })
  @ApiBody(zodBody(signupSchema, 'Signup request'))
  @ApiResponse({ status: 201, description: 'Account created; merchant object returned. konfirm_session cookie set.' })
  @ApiResponse({ status: 409, description: 'Email already registered.' })
  @ApiResponse({ status: 422, description: 'Validation error (email format, password length, invalid Stellar address, etc.).' })
  async signup(
    @Body(new ZodValidationPipe(signupSchema)) body: z.infer<typeof signupSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, merchant } = await this.auth.signup(
      body.email,
      body.password,
      body.name,
      body.stellar_base_address,
      body.referral_code,
    );
    this.setSessionCookie(res, token);
    return { merchant };
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Log in as a merchant',
    description:
      'Returns a session cookie on success. Intentionally uses the same error ' +
      'for wrong email and wrong password to prevent account enumeration.',
  })
  @ApiBody(zodBody(loginSchema, 'Login request'))
  @ApiResponse({ status: 200, description: 'Login successful; merchant object returned. konfirm_session cookie set.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials (same response for wrong email or wrong password).' })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, merchant } = await this.auth.login(body.email, body.password);
    this.setSessionCookie(res, token);
    return { merchant };
  }

  // Always the same response, whether or not the email has an account. A
  // mail failure is logged server-side and not shown to the caller, because
  // showing it would tell an attacker the address was real.
  @Post('forgot-password')
  @HttpCode(200)
  @Throttle(FORGOT_THROTTLE)
  @ApiOperation({
    summary: 'Request a password-reset email',
    description:
      'Always returns `{ ok: true }` regardless of whether the email exists — ' +
      'prevents enumeration. Rate-limited to 5 req/min per IP.',
  })
  @ApiBody(zodBody(forgotPasswordSchema, 'Forgot password request'))
  @ApiResponse({ status: 200, description: 'Always returns { ok: true }.' })
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordSchema)) body: z.infer<typeof forgotPasswordSchema>) {
    try {
      await this.auth.requestPasswordReset(body.email);
    } catch (err) {
      this.logger.error(`password reset email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Reset password using a token from the reset email',
    description:
      'Token is valid for 30 minutes and single-use. Bumps session_version, ' +
      'signing out every existing session including any a thief holds.',
  })
  @ApiBody(zodBody(resetPasswordSchema, 'Reset password request'))
  @ApiResponse({ status: 200, description: 'Password reset successful.' })
  @ApiResponse({ status: 400, description: 'Token invalid, expired, or already used.' })
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }

  // Revokes server-side as well as clearing the cookie: a copy of the token
  // taken before logout must stop working, not just be forgotten by the browser.
  @Post('logout')
  @HttpCode(200)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Log out',
    description: 'Revokes all of the merchant\'s sessions server-side (bumps session_version) and clears the cookie.',
  })
  @ApiResponse({ status: 200, description: 'Logged out. Returns { ok: true }.' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({ summary: 'Get current merchant', description: 'Returns the authenticated merchant\'s profile from their session claims.' })
  @ApiResponse({ status: 200, description: 'Current merchant object.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  me(@Req() req: AuthedRequest) {
    return { merchant: req.merchant };
  }

  @Get('me/referrals')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({ summary: 'List my referrals', description: 'Returns referral records attributed to the current merchant.' })
  @ApiResponse({ status: 200, description: 'Array of referral records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  myReferrals(@Req() req: AuthedRequest) {
    return this.auth.myReferrals(req.merchant.id);
  }

  private setSessionCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      // Driven by NODE_ENV rather than a manual flip at deploy time — plain
      // http locally (NODE_ENV unset/development), real HTTPS wherever
      // NODE_ENV=production is actually set (see README's Deployment
      // section), so this is correct by construction instead of relying on
      // someone remembering to edit this after the first real deploy.
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }
}
