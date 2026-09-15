import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => true),
}));

vi.mock('@/lib/notifications/email', () => ({
  sendEmail: mocks.sendEmail,
}));

import { buildPasswordResetMail, deliverPasswordResetLink } from './password-reset-delivery';

describe('password reset mail (issue #30)', () => {
  afterEach(() => {
    mocks.sendEmail.mockClear();
    delete process.env.SMTP_ENABLED;
    delete process.env.PASSWORD_RESET_WEBHOOK_URL;
    delete process.env.NOTIFICATION_EMAIL_WEBHOOK_URL;
  });

  it('ne contient que destinataire, sujet et texte — pas de champ resetUrl séparé pour un webhook', () => {
    const mail = buildPasswordResetMail('user@example.test', 'https://app.example/reinitialiser/abc');
    expect(Object.keys(mail).sort()).toEqual(['subject', 'text', 'to']);
    expect(JSON.stringify(mail)).not.toMatch(/"resetUrl"/);
  });

  it('n’appelle aucun webhook même si les URL historiques sont posées', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    process.env.PASSWORD_RESET_WEBHOOK_URL = 'https://hooks.example/reset';
    process.env.NOTIFICATION_EMAIL_WEBHOOK_URL = 'https://hooks.example/mail';

    await expect(deliverPasswordResetLink(
      'user@example.test',
      'https://app.example/reinitialiser/deadbeef',
      'demo-club',
    )).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('envoie uniquement via SMTP une fois SMTP_ENABLED=true', async () => {
    process.env.SMTP_ENABLED = 'true';
    await expect(deliverPasswordResetLink(
      'user@example.test',
      'https://app.example/reinitialiser/deadbeef',
      'demo-club',
    )).resolves.toBe(true);
    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: 'user@example.test',
      subject: 'Réinitialisation de votre mot de passe Clubika',
      text: expect.stringContaining('/reinitialiser/deadbeef'),
      clubId: 'demo-club',
    });
  });
});
