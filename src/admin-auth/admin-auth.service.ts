import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { resolveSessionSecret } from '../common/secrets';

// A separate signing key from the merchant JWT_SECRET — a leaked merchant
// secret must never be usable to forge an admin session. Same fail-open-
// but-never-silent dev fallback as auth.service.ts.
// Production refuses to start without a real secret — see common/secrets.ts.
const ADMIN_JWT_SECRET = resolveSessionSecret('ADMIN_JWT_SECRET', 'dev-only-insecure-admin-secret-change-me');
// Shorter than the merchant session's 30 days — a higher-privilege surface
// gets a shorter-lived token, not the same default.
const TOKEN_TTL = '12h';

export interface AdminClaims {
  id: string;
  email: string;
  name: string;
  sv?: number;
}

@Injectable()
export class AdminAuthService {
  // No signup() here on purpose — see admin-auth.controller.ts.

  async login(email: string, password: string): Promise<{ token: string; admin: AdminClaims }> {
    // Matched case-insensitively: admin rows aren't constrained to lowercase.
    const { rows } = await pool.query('SELECT id, email, name, password_hash, session_version FROM admins WHERE lower(email) = $1', [
      email.trim().toLowerCase(),
    ]);
    // Same generic error whether the email doesn't exist or the password is
    // wrong, same reasoning as auth.service.ts.
    const invalid = () => new UnauthorizedException('invalid email or password');
    if (rows.length === 0) throw invalid();

    const row = rows[0];
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) throw invalid();

    const admin: AdminClaims = { id: row.id, email: row.email, name: row.name };
    return { token: this.issueToken(admin, row.session_version), admin };
  }

  verifyToken(token: string): AdminClaims {
    try {
      return jwt.verify(token, ADMIN_JWT_SECRET) as unknown as AdminClaims;
    } catch {
      throw new UnauthorizedException('session expired or invalid — please log in again');
    }
  }

  // Bumps session_version so the token being logged out, and any copy of it,
  // stops passing AdminGuard. A missing or already-invalid token is a no-op.
  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    let claims: AdminClaims;
    try {
      claims = this.verifyToken(token);
    } catch {
      return;
    }
    await pool.query('UPDATE admins SET session_version = session_version + 1 WHERE id = $1', [claims.id]);
  }

  private issueToken(admin: AdminClaims, sessionVersion: number): string {
    return jwt.sign({ id: admin.id, email: admin.email, name: admin.name, sv: sessionVersion }, ADMIN_JWT_SECRET, {
      expiresIn: TOKEN_TTL,
    });
  }
}
