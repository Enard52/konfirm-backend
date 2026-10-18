import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { AdminAuthService } from './admin-auth.service';

// Passthrough: the real bcrypt still runs, but compare() calls can be counted.
// A jest.spyOn wouldn't reach the service, since esModuleInterop gives each
// importing module its own copy of the namespace.
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof import('bcryptjs')>('bcryptjs');
  return { ...actual, compare: jest.fn(actual.compare) };
});

// Hits the real konfirm_test Postgres database (see test/env.ts), same
// no-mocks approach as auth.service.spec.ts. AdminAuthService has no
// signup() by design (see admin-auth.controller.ts) — this suite inserts
// admin rows directly, the same way db/seed-admin.ts does.
describe('AdminAuthService (integration, real Postgres)', () => {
  const adminAuth = new AdminAuthService();
  const testEmails: string[] = [];

  function freshAdminEmail(): string {
    const email = `admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    testEmails.push(email);
    return email;
  }

  async function createAdmin(email: string, password: string, name: string): Promise<string> {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO admins (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, name],
    );
    return rows[0].id;
  }

  afterAll(async () => {
    if (testEmails.length > 0) {
      await pool.query('DELETE FROM admin_actions WHERE admin_id IN (SELECT id FROM admins WHERE email = ANY($1))', [testEmails]);
      await pool.query('DELETE FROM admins WHERE email = ANY($1)', [testEmails]);
    }
    await pool.end();
  });

  it('logs in with the correct password and returns a usable token', async () => {
    const email = freshAdminEmail();
    await createAdmin(email, 'correct-horse-battery-staple', 'Test Admin');

    const { token, admin } = await adminAuth.login(email, 'correct-horse-battery-staple');
    expect(admin.email).toBe(email);
    expect(token).toEqual(expect.any(String));

    const claims = adminAuth.verifyToken(token);
    expect(claims.email).toBe(email);
    expect(claims.id).toBe(admin.id);
  });

  it('rejects the wrong password with the generic message', async () => {
    const email = freshAdminEmail();
    await createAdmin(email, 'the-real-password', 'Wrong Pw Test');

    await expect(adminAuth.login(email, 'not-the-real-password')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a nonexistent email with the exact same message as a wrong password — no account enumeration', async () => {
    let wrongPasswordMessage = '';
    let nonexistentEmailMessage = '';

    const email = freshAdminEmail();
    await createAdmin(email, 'some-password-here', 'Enum Test');

    try {
      await adminAuth.login(email, 'wrong-password');
    } catch (err) {
      wrongPasswordMessage = (err as UnauthorizedException).message;
    }

    try {
      await adminAuth.login('definitely-not-an-admin@example.com', 'anything');
    } catch (err) {
      nonexistentEmailMessage = (err as UnauthorizedException).message;
    }

    expect(wrongPasswordMessage).not.toBe('');
    expect(wrongPasswordMessage).toBe(nonexistentEmailMessage);
  });

  it('does the same bcrypt work for a nonexistent email as for a wrong password — no timing-based enumeration', async () => {
    const email = freshAdminEmail();
    await createAdmin(email, 'the-real-password', 'Timing Test');
    const compare = jest.mocked(bcrypt.compare);

    compare.mockClear();
    await expect(adminAuth.login(email, 'not-the-real-password')).rejects.toThrow('invalid email or password');
    const wrongPasswordCompares = compare.mock.calls.length;

    compare.mockClear();
    await expect(adminAuth.login(`no-such-admin-${Date.now()}@example.com`, 'not-the-real-password')).rejects.toThrow(
      'invalid email or password',
    );
    const nonexistentEmailCompares = compare.mock.calls.length;

    expect(wrongPasswordCompares).toBe(1);
    expect(nonexistentEmailCompares).toBe(wrongPasswordCompares);
  });

  it('rejects a token signed with a different secret (admin tokens are not merchant tokens)', () => {
    const forgedWithMerchantSecret = jwt.sign({ id: 'x', email: 'x@example.com', name: 'x' }, 'dev-only-insecure-secret-change-me');
    expect(() => adminAuth.verifyToken(forgedWithMerchantSecret)).toThrow(UnauthorizedException);
  });
});
