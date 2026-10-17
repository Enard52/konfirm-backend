import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';

// The x402 facilitator is called by unrelated third parties by design (same
// "no AuthGuard" reasoning documented on x402.controller.ts/
// deposits.controller.ts) — it must accept any origin. Everything else
// (admin/auth/links/withdrawals/deposits/payments) is credential-bearing
// and, in production, only ever called same-origin through the frontend's
// own BFF proxy (next.config.ts rewrites /api/backend/* server-to-server —
// the browser never crosses origins for these today), so restricting
// cross-origin credentialed access here is pure defense-in-depth, not
// something the real frontend flow depends on. Unset CORS_ALLOWED_ORIGINS
// means "deny all cross-origin credentialed requests" — secure by default,
// opt-in to loosen, not the other way around.
export function buildCorsMiddleware() {
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const openCors = cors();
  const restrictedCors = cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : false, credentials: true });
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/x402')) return openCors(req, res, next);
    return restrictedCors(req, res, next);
  };
}
