import { describe, expect, it, vi } from 'vitest';
import {
  allowedHostnamesFor,
  assertExternalUrlAllowed,
  ExternalServiceBlockedError,
  EXTERNAL_SERVICE_IDS,
  guardedFetch,
  hostnameAllowed,
  isExternalServiceEnabled,
  isSmtpHostAllowed,
  listExternalServiceStatuses,
} from './external-services';
import { buildSmtpTransportOptions } from './smtp-tls';

const EMPTY = {};

describe('external services registry (issue #30)', () => {
  it('inventorie chaque flux sortant avec finalité et catégories de données', () => {
    const statuses = listExternalServiceStatuses(EMPTY);
    expect(statuses.map((item) => item.id).sort()).toEqual([...EXTERNAL_SERVICE_IDS].sort());
    for (const status of statuses) {
      expect(status.enabled).toBe(false);
      expect(status.legalReview).toBe('required');
      expect(status.dataCategories.length).toBeGreaterThan(0);
      expect(status.purpose.length).toBeGreaterThan(0);
    }
  });

  it('n’active un service en production que si le drapeau explicite est posé', () => {
    const prod = { NODE_ENV: 'production' };
    expect(isExternalServiceEnabled('smtp', prod)).toBe(false);
    expect(isExternalServiceEnabled('smtp', { ...prod, SMTP_ENABLED: 'true' })).toBe(true);
    expect(isExternalServiceEnabled('smtp', { ...prod, SMTP_ENABLED: '1' })).toBe(false);
    expect(isExternalServiceEnabled('open-meteo', { ...prod, OPEN_METEO_ENABLED: 'true' })).toBe(true);
    expect(isExternalServiceEnabled('routing', { ...prod, ROUTING_ENABLED: 'true' })).toBe(true);
    expect(isExternalServiceEnabled('logo-proxy', { ...prod, LOGO_PROXY_ENABLED: 'true' })).toBe(true);
    expect(isExternalServiceEnabled('web-push', { ...prod, WEB_PUSH_ENABLED: 'true' })).toBe(true);
    expect(isExternalServiceEnabled('sportcorico', { ...prod, SPORTCORICO_SYNC_ENABLED: 'true' })).toBe(true);
  });

  it('n’active WhatsApp que si WHATSAPP_PROVIDER est explicite (pas les secrets seuls)', () => {
    expect(isExternalServiceEnabled('whatsapp', {
      WHATSAPP_META_PHONE_NUMBER_ID: '123',
      WHATSAPP_META_ACCESS_TOKEN: 'secret',
      WHATSAPP_META_GRAPH_VERSION: 'v23.0',
    })).toBe(false);
    expect(isExternalServiceEnabled('whatsapp', { WHATSAPP_PROVIDER: 'meta' })).toBe(true);
    expect(isExternalServiceEnabled('whatsapp', { WHATSAPP_PROVIDER: 'webhook' })).toBe(true);
    expect(isExternalServiceEnabled('whatsapp', { WHATSAPP_PROVIDER: 'disabled' })).toBe(false);
  });

  it('refuse les hôtes publics de démonstration tant que l’URL n’est pas posée', () => {
    expect(allowedHostnamesFor('routing', { NODE_ENV: 'production', ROUTING_ENABLED: 'true' })).toEqual([]);
    expect(allowedHostnamesFor('open-meteo', { NODE_ENV: 'production', OPEN_METEO_ENABLED: 'true' })).toEqual([]);
    expect(allowedHostnamesFor('logo-proxy', { NODE_ENV: 'production', LOGO_PROXY_ENABLED: 'true' })).toEqual([]);
    expect(() => assertExternalUrlAllowed(
      'routing',
      'https://router.project-osrm.org/route/v1/driving/1,2;3,4',
      { NODE_ENV: 'production', ROUTING_ENABLED: 'true' },
    )).toThrow(ExternalServiceBlockedError);
  });

  it('allowliste uniquement l’hôte de l’URL configurée', () => {
    const env = {
      ROUTING_ENABLED: 'true',
      ROUTING_API_BASE_URL: 'https://osrm.club.example/route',
    };
    expect(assertExternalUrlAllowed(
      'routing',
      'https://osrm.club.example/route/v1/driving/1,2;3,4',
      env,
    ).hostname).toBe('osrm.club.example');
    expect(() => assertExternalUrlAllowed(
      'routing',
      'https://router.project-osrm.org/route/v1/driving/1,2;3,4',
      env,
    )).toThrow(/allowlisté/);
  });

  it('bloque un fetch vers un hôte hors allowlist', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    await expect(guardedFetch(
      'sportcorico',
      'https://evil.example/api',
      undefined,
      fetchImpl,
      { SPORTCORICO_SYNC_ENABLED: 'true' },
    )).rejects.toThrow(ExternalServiceBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('laisse passer un fetch allowlisté une fois le kill switch ouvert', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const response = await guardedFetch(
      'sportcorico',
      'https://api.sportcorico.com/api/match/demo',
      { headers: { Accept: 'application/json' } },
      fetchImpl,
      { SPORTCORICO_SYNC_ENABLED: 'true' },
    );
    expect(response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reconnaît les motifs d’hôtes Web Push', () => {
    expect(hostnameAllowed('fcm.googleapis.com', ['fcm.googleapis.com'])).toBe(true);
    expect(hostnameAllowed('updates.push.services.mozilla.com', ['*.push.services.mozilla.com'])).toBe(true);
    expect(hostnameAllowed('evil.example', ['*.push.services.mozilla.com'])).toBe(false);
  });
});

describe('SMTP TLS (issue #30)', () => {
  const endpoint = {
    host: 'smtp.club.example',
    port: 587,
    user: 'mailer',
    password: 'secret',
    secure: false,
  };

  it('refuse l’envoi tant que SMTP_ENABLED n’est pas true', () => {
    expect(isSmtpHostAllowed('smtp.club.example', {})).toBe(false);
    expect(buildSmtpTransportOptions(endpoint, {})).toBeNull();
  });

  it('exige STARTTLS vérifié sur le port 587, sans downgrade', () => {
    const options = buildSmtpTransportOptions(endpoint, {
      NODE_ENV: 'production',
      SMTP_ENABLED: 'true',
    });
    expect(options).toMatchObject({
      host: 'smtp.club.example',
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
  });

  it('utilise le TLS implicite sur le port 465', () => {
    const options = buildSmtpTransportOptions({ ...endpoint, port: 465, secure: true }, {
      NODE_ENV: 'production',
      SMTP_ENABLED: 'true',
    });
    expect(options).toMatchObject({
      secure: true,
      requireTLS: false,
      tls: { rejectUnauthorized: true },
    });
  });

  it('n’autorise pas SMTP_ALLOW_INSECURE en production', () => {
    const options = buildSmtpTransportOptions(endpoint, {
      NODE_ENV: 'production',
      SMTP_ENABLED: 'true',
      SMTP_ALLOW_INSECURE: 'true',
    });
    expect(options?.tls.rejectUnauthorized).toBe(true);
  });

  it('restreint l’hôte si SMTP_ALLOWED_HOSTS est posé', () => {
    expect(isSmtpHostAllowed('smtp.other.example', {
      SMTP_ENABLED: 'true',
      SMTP_ALLOWED_HOSTS: 'smtp.club.example',
    })).toBe(false);
    expect(isSmtpHostAllowed('smtp.club.example', {
      SMTP_ENABLED: 'true',
      SMTP_ALLOWED_HOSTS: 'smtp.club.example',
    })).toBe(true);
  });
});
