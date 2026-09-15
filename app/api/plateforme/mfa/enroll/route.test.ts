import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { PlatformAdminEntity } from '@/lib/db/schemas';
import { hashPassword } from '@/lib/auth/password';
import { generateTotp } from '@/lib/auth/totp';
import { POST as loginPost, PUT as loginPut } from '@/app/api/plateforme/login/route';
import { GET as enrollGet, POST as enrollPost } from '@/app/api/plateforme/mfa/enroll/route';
import { consumeRecoveryCode } from '@/lib/auth/platform-mfa';

const dbAvailable = await isDbAvailable();

function loginRequest(body: unknown, ip = randomBytes(8).toString('hex'), cookie?: string) {
  return new NextRequest('http://localhost/api/plateforme/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
    },
  });
}

describe.skipIf(!dbAvailable)('MFA plateforme (issue #32)', () => {
  const email = `platform-mfa-${randomBytes(6).toString('hex')}@example.com`;
  let adminId: number | undefined;

  afterEach(async () => {
    const db = await getDb();
    if (adminId) {
      await db.getRepository('PlatformMfaRecoveryCode').delete({ platformAdminId: adminId });
      await db.getRepository('PlatformMfaChallenge').delete({ platformAdminId: adminId });
      await db.getRepository('PlatformSession').createQueryBuilder().delete().where('platformAdminId = :adminId', { adminId }).execute();
      await db.getRepository('PlatformAdmin').delete({ id: adminId });
      adminId = undefined;
    }
  });

  it('enrôle le TOTP, refuse un replay du challenge, et accepte un code de récupération hashé', async () => {
    const db = await getDb();
    const admin = await db.getRepository<PlatformAdminEntity>('PlatformAdmin').save({
      email,
      passwordHash: await hashPassword('correct-horse-battery'),
      nom: 'MFA Test',
      active: true,
    });
    adminId = admin.id;

    const login = await loginPost(loginRequest({ email, password: 'correct-horse-battery' }));
    expect(login.status).toBe(200);
    const loginBody = await login.json() as { mfaEnrollmentRequired?: boolean };
    expect(loginBody.mfaEnrollmentRequired).toBe(true);
    const pending = login.cookies.get('platform_mfa_pending')?.value;
    expect(pending).toBeTruthy();
    expect(login.cookies.get('platform_session_token')?.value).toBeFalsy();

    const cookie = `platform_mfa_pending=${pending}`;
    const begin = await enrollGet(new NextRequest('http://localhost/api/plateforme/mfa/enroll', {
      headers: { cookie },
    }));
    expect(begin.status).toBe(200);
    const beginBody = await begin.json() as { secret: string; otpauthUrl: string };
    expect(beginBody.secret).toMatch(/^[A-Z2-7]+$/);
    expect(beginBody.otpauthUrl).toContain('otpauth://totp/');

    const confirm = await enrollPost(new NextRequest('http://localhost/api/plateforme/mfa/enroll', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ totp: generateTotp(beginBody.secret) }),
    }));
    expect(confirm.status).toBe(200);
    const confirmBody = await confirm.json() as { recoveryCodes?: string[]; success?: boolean };
    expect(confirmBody.success).toBe(true);
    expect(confirmBody.recoveryCodes).toHaveLength(10);
    expect(confirm.cookies.get('platform_session_token')?.value).toBeTruthy();

    const replay = await enrollPost(new NextRequest('http://localhost/api/plateforme/mfa/enroll', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ totp: generateTotp(beginBody.secret) }),
    }));
    expect(replay.status).toBe(401);

    const recovery = confirmBody.recoveryCodes![0]!;
    const stored = await db.getRepository('PlatformMfaRecoveryCode').findBy({ platformAdminId: admin.id }) as Array<{ codeHash: string }>;
    expect(stored.every((row: { codeHash: string }) => row.codeHash !== recovery.replace('-', ''))).toBe(true);

    expect(await consumeRecoveryCode(admin.id, recovery)).toBe(true);
    expect(await consumeRecoveryCode(admin.id, recovery)).toBe(false);

    const totpLogin = await loginPost(loginRequest({
      email,
      password: 'correct-horse-battery',
      totp: generateTotp(beginBody.secret),
    }));
    expect(totpLogin.status).toBe(200);
    expect((await totpLogin.json() as { success?: boolean }).success).toBe(true);
    expect(totpLogin.cookies.get('platform_session_token')?.value).toBeTruthy();
  });

  it('refuse un TOTP faux après mot de passe correct (verrouillage déjà couvert par le login)', async () => {
    const db = await getDb();
    const admin = await db.getRepository<PlatformAdminEntity>('PlatformAdmin').save({
      email: `platform-mfa-bad-${randomBytes(4).toString('hex')}@example.com`,
      passwordHash: await hashPassword('correct-horse-battery'),
      nom: 'MFA Bad',
      active: true,
      totpSecretEncrypted: 'MFRGGZDFMZTWQ2LK',
      totpEnrolledAt: new Date(),
    });
    adminId = admin.id;

    const login = await loginPost(loginRequest({
      email: admin.email,
      password: 'correct-horse-battery',
      totp: '000000',
    }));
    expect(login.status).toBe(200);
    const body = await login.json() as { mfaRequired?: boolean };
    expect(body.mfaRequired).toBe(true);

    const pending = login.cookies.get('platform_mfa_pending')?.value;
    const verify = await loginPut(new NextRequest('http://localhost/api/plateforme/login', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        cookie: `platform_mfa_pending=${pending}`,
      },
      body: JSON.stringify({ totp: '000000' }),
    }));
    expect(verify.status).toBe(401);
  });
});
