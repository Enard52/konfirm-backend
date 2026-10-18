import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { AdminAuthService } from './admin-auth.service';

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

  describe('changePassword', () => {
    it('rotates the password, bumps session_version, and logs the change', async () => {
      const email = freshAdminEmail();
      const id = await createAdmin(email, 'old-admin-password', 'Rotate Test');
      const { token: before } = await adminAuth.login(email, 'old-admin-password');

      const { token, admin } = await adminAuth.changePassword(id, 'old-admin-password', 'new-admin-password');
      expect(admin.id).toBe(id);
      expect(adminAuth.verifyToken(token).sv).toBe(adminAuth.verifyToken(before).sv! + 1);

      await expect(adminAuth.login(email, 'old-admin-password')).rejects.toThrow(UnauthorizedException);
      await expect(adminAuth.login(email, 'new-admin-password')).resolves.toBeDefined();

      const { rows } = await pool.query(
        `SELECT target_type, target_id FROM admin_actions WHERE admin_id = $1 AND action = 'admin.change-password'`,
        [id],
      );
      expect(rows).toEqual([{ target_type: 'admin', target_id: id }]);
    });

    it('rejects a wrong current password and leaves everything as it was', async () => {
      const email = freshAdminEmail();
      const id = await createAdmin(email, 'the-real-password', 'Wrong Current Test');

      await expect(adminAuth.changePassword(id, 'not-the-real-password', 'new-admin-password')).rejects.toThrow(
        BadRequestException,
      );
      await expect(adminAuth.login(email, 'the-real-password')).resolves.toBeDefined();
      const { rows } = await pool.query('SELECT session_version FROM admins WHERE id = $1', [id]);
      expect(rows[0].session_version).toBe(0);
      const logged = await pool.query('SELECT 1 FROM admin_actions WHERE admin_id = $1', [id]);
      expect(logged.rows.length).toBe(0);
    });

    it('rejects a new password equal to the current one', async () => {
      const email = freshAdminEmail();
      const id = await createAdmin(email, 'same-old-password', 'Same Password Test');
      await expect(adminAuth.changePassword(id, 'same-old-password', 'same-old-password')).rejects.toThrow(BadRequestException);
    });
  });

  it('rejects a token signed with a different secret (admin tokens are not merchant tokens)', () => {
    const forgedWithMerchantSecret = jwt.sign({ id: 'x', email: 'x@example.com', name: 'x' }, 'dev-only-insecure-secret-change-me');
    expect(() => adminAuth.verifyToken(forgedWithMerchantSecret)).toThrow(UnauthorizedException);
  });
});
