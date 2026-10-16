import express from 'express';
import request from 'supertest';
import { buildCorsMiddleware } from './cors';
import { AuthController } from '../auth/auth.controller';
import { AdminAuthController } from '../admin-auth/admin-auth.controller';

// Regression guard for the cross-origin/CSRF config: no full Nest bootstrap,
// just the real `cors` package and the real cookie-setting code paths.
function appWith(allowed: string | undefined) {
  if (allowed === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = allowed;
  const app = express();
  app.use(buildCorsMiddleware());
  app.get('/auth/me', (_req, res) => res.json({ ok: true }));
  app.get('/x402/supported', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('buildCorsMiddleware', () => {
  const original = process.env.CORS_ALLOWED_ORIGINS;
  afterAll(() => {
    if (original === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = original;
  });

  it('denies all cross-origin credentialed requests when unset', async () => {
    const res = await request(appWith(undefined)).get('/auth/me').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not reflect a non-allowlisted origin', async () => {
    const res = await request(appWith('https://app.konfirm.xyz')).get('/auth/me').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes exactly the allowlisted origin, with credentials, never a wildcard', async () => {
    const res = await request(appWith('https://app.konfirm.xyz, https://admin.konfirm.xyz'))
      .get('/auth/me')
      .set('Origin', 'https://admin.konfirm.xyz');
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.konfirm.xyz');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('keeps /x402 open but never credentialed', async () => {
    const res = await request(appWith(undefined)).get('/x402/supported').set('Origin', 'https://anyone.example');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('session cookie attributes', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  function cookieFrom(controller: object, env: string) {
    process.env.NODE_ENV = env;
    const res = { cookie: jest.fn() };
    (controller as { setSessionCookie(res: unknown, token: string): void }).setSessionCookie(res, 'tok');
    return res.cookie.mock.calls[0][2];
  }

  it.each(['development', 'production'])('merchant cookie is SameSite=Lax + HttpOnly (NODE_ENV=%s)', (env) => {
    const opts = cookieFrom(Object.create(AuthController.prototype), env);
    expect(opts.sameSite).toBe('lax');
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(env === 'production');
  });

  it.each(['development', 'production'])('admin cookie is SameSite=Strict + HttpOnly (NODE_ENV=%s)', (env) => {
    const opts = cookieFrom(Object.create(AdminAuthController.prototype), env);
    expect(opts.sameSite).toBe('strict');
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(env === 'production');
  });
});
