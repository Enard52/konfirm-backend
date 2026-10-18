import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { pool } from '../src/db/pool';

// Self-service admin password change, end to end. Mirrors the merchant
// account-recovery cases: the old password stops working, the new one works,
// and sessions issued before the change are signed out.
describe('admin password change (e2e)', () => {
  let app: INestApplication;
  const stamp = Date.now();
  const adminEmail = `admin-pw-${stamp}@example.com`;
  const oldPassword = 'original-admin-passphrase';
  const newPassword = 'replacement-admin-passphrase';
  let adminId: string;
  let cookie: string;
  let otherSessionCookie: string;

  const login = async (password: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/admin/auth/login').send({ email: adminEmail, password }).expect(200);
    return res.headers['set-cookie'][0].split(';')[0];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();

    const { rows } = await pool.query('INSERT INTO admins (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id', [
      adminEmail,
      await bcrypt.hash(oldPassword, 10),
      'Password Change Admin',
    ]);
    adminId = rows[0].id;
    cookie = await login(oldPassword);
    otherSessionCookie = await login(oldPassword);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM admin_actions WHERE admin_id IN (SELECT id FROM admins WHERE email = $1)', [adminEmail]);
    await pool.query('DELETE FROM admins WHERE email = $1', [adminEmail]);
    await app.close();
    await pool.end();
  });

  it('requires an admin session', async () => {
    await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .send({ current_password: oldPassword, new_password: newPassword })
      .expect(401);
  });

  it('rejects a wrong current password without changing anything', async () => {
    await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .set('Cookie', cookie)
      .send({ current_password: 'not-the-current-password', new_password: newPassword })
      .expect(400);
    await request(app.getHttpServer()).get('/admin/auth/me').set('Cookie', cookie).expect(200);
  });

  it('rejects a new password that is too short', async () => {
    await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .set('Cookie', cookie)
      .send({ current_password: oldPassword, new_password: 'short' })
      .expect(400);
  });

  it('rejects a new password longer than bcrypt can use', async () => {
    await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .set('Cookie', cookie)
      .send({ current_password: oldPassword, new_password: 'é'.repeat(40) })
      .expect(400);
  });

  it('rejects reusing the current password', async () => {
    await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .set('Cookie', cookie)
      .send({ current_password: oldPassword, new_password: oldPassword })
      .expect(400);
  });

  it('logs nothing for the failed attempts', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM admin_actions WHERE admin_id = $1 AND action = 'admin.change-password'`,
      [adminId],
    );
    expect(rows.length).toBe(0);
  });

  it('changes the password, keeps this session, and signs out every other one', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .set('Cookie', cookie)
      .send({ current_password: oldPassword, new_password: newPassword })
      .expect(200);
    expect(res.body.admin.email).toBe(adminEmail);

    const rawCookie = res.headers['set-cookie']?.[0];
    expect(rawCookie).toContain('konfirm_admin_session=');
    const freshCookie = rawCookie.split(';')[0];

    await request(app.getHttpServer()).get('/admin/auth/me').set('Cookie', freshCookie).expect(200);
    await request(app.getHttpServer()).get('/admin/auth/me').set('Cookie', cookie).expect(401);
    await request(app.getHttpServer()).get('/admin/auth/me').set('Cookie', otherSessionCookie).expect(401);
    cookie = freshCookie;
  });

  it('accepts only the new password at login', async () => {
    await request(app.getHttpServer()).post('/admin/auth/login').send({ email: adminEmail, password: oldPassword }).expect(401);
    await login(newPassword);
  });

  it('logs the change to admin_actions, with nothing about the password in it', async () => {
    const { rows } = await pool.query(
      `SELECT target_type, target_id, detail FROM admin_actions WHERE admin_id = $1 AND action = 'admin.change-password'`,
      [adminId],
    );
    expect(rows).toEqual([{ target_type: 'admin', target_id: adminId, detail: null }]);
  });

  it('will not accept the old password as the current one any more', async () => {
    await request(app.getHttpServer())
      .post('/admin/auth/change-password')
      .set('Cookie', cookie)
      .send({ current_password: oldPassword, new_password: 'a-third-admin-passphrase' })
      .expect(400);
  });
});
