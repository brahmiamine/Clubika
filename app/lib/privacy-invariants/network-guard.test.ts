/**
 * Frontière : prestataires externes (issue #30) — garde réseau bloquante.
 *
 * `vitest.setup.ts` bloque déjà tout `fetch` non-localhost pour l'ensemble de la
 * suite (fail-on-unexpected-call global). Ce fichier vérifie en plus, avec des
 * données strictement sentinelles, que :
 *  - chaque intégration externe est désactivée par défaut (même en production) ;
 *  - un appel explicite vers un prestataire désactivé échoue avant tout `fetch` ;
 *  - le flux Web Push n'envoie rien à un endpoint qui n'est pas un service de
 *    push navigateur de confiance ;
 *  - le payload envoyé au prestataire de push ne contient que les champs de
 *    notification attendus (pas de nom, e-mail, texte libre autre que le
 *    message de notification lui-même).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  EXTERNAL_SERVICE_IDS,
  ExternalServiceBlockedError,
  guardedFetch,
  isExternalServiceEnabled,
  listExternalServiceStatuses,
} from '@/lib/compliance/external-services';
import { isTrustedPushEndpoint } from '@/lib/push/endpoint';
import { findRealisticPii } from './pii-heuristics';
import { sentinelClubId, sentinelEmail, sentinelName } from './sentinel-factory';

const pushMocks = vi.hoisted(() => ({
  sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  listPushSubscriptionsForUser: vi.fn(async () => [{
    endpoint: 'https://fcm.googleapis.com/fcm/send/sentinel-subscription',
    endpointHash: 'hash',
    p256dh: 'public-key',
    auth: 'auth-secret',
  }]),
  removePushSubscriptionByEndpoint: vi.fn(async () => undefined),
}));

vi.mock('web-push', () => ({ default: { sendNotification: pushMocks.sendNotification } }));
vi.mock('@/lib/push/vapid', () => ({
  buildVapidAuthorization: vi.fn(),
  getVapidConfig: () => ({ publicKey: 'vapid-public', privateKey: 'vapid-private', subject: 'mailto:privacy-invariants@example.test' }),
}));
vi.mock('@/lib/push/store', () => ({
  listPushSubscriptionsForUser: pushMocks.listPushSubscriptionsForUser,
  removePushSubscriptionByEndpoint: pushMocks.removePushSubscriptionByEndpoint,
}));

describe('frontière: prestataires externes désactivés par défaut (issue #30)', () => {
  it('aucun service externe n\'est actif sans variable d\'environnement explicite, y compris en prod', () => {
    const statuses = listExternalServiceStatuses({ NODE_ENV: 'production' });
    expect(statuses.map((s) => s.id).sort()).toEqual([...EXTERNAL_SERVICE_IDS].sort());
    for (const status of statuses) {
      expect(status.enabled, `${status.id} ne doit pas être actif par défaut`).toBe(false);
    }
  });

  it('refuse l\'appel réseau avant même de le tenter quand le service est désactivé', async () => {
    const fetchSpy = vi.fn(async () => new Response('should not be called'));
    await expect(
      guardedFetch('open-meteo', 'https://api.open-meteo.com/v1/forecast?lat=1&lon=1', undefined, fetchSpy, {}),
    ).rejects.toBeInstanceOf(ExternalServiceBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuse un hôte non allowlisté même quand le service est activé', async () => {
    const fetchSpy = vi.fn(async () => new Response('should not be called'));
    await expect(
      guardedFetch(
        'routing',
        'https://attacker.example.test/route',
        undefined,
        fetchSpy,
        { ROUTING_ENABLED: 'true', ROUTING_API_BASE_URL: 'https://router.internal.example.test' },
      ),
    ).rejects.toBeInstanceOf(ExternalServiceBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('isExternalServiceEnabled reste false pour un flag mal orthographié ou vide', () => {
    expect(isExternalServiceEnabled('smtp', { SMTP_ENABLED: '1' })).toBe(false);
    expect(isExternalServiceEnabled('smtp', { SMTP_ENABLED: 'TRUE' })).toBe(false);
    expect(isExternalServiceEnabled('smtp', {})).toBe(false);
  });
});

describe('frontière: endpoint push de confiance (issue #219 / #30)', () => {
  it('rejette un endpoint hors des services de push navigateur reconnus', () => {
    expect(isTrustedPushEndpoint(`https://push.example.test/${sentinelClubId()}`)).toBe(false);
    expect(isTrustedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
  });
});

describe('frontière: payload Web Push minimisé (issue #30 / #219)', () => {
  beforeEach(() => {
    vi.stubEnv('WEB_PUSH_ENABLED', 'true');
    pushMocks.sendNotification.mockClear();
  });

  it('n\'envoie que les champs de notification attendus, jamais un nom ou un e-mail brut', async () => {
    const { triggerPushForUser } = await import('@/lib/push/service');
    const db = {} as DataSource;

    await triggerPushForUser(db, 42, {
      notificationId: 'delivery-sentinel-1',
      type: 'assignment',
      title: sentinelName('Notification'),
      message: 'Vous avez une nouvelle affectation.',
      eventType: 'amical',
      eventId: 'match-sentinel-1',
      url: '/notifications',
      clubId: sentinelClubId('push'),
    });

    expect(pushMocks.sendNotification).toHaveBeenCalledTimes(1);
    const call = pushMocks.sendNotification.mock.calls[0] as unknown[] | undefined;
    const sentBody = JSON.parse(String(call?.[1]));
    expect(Object.keys(sentBody).sort()).toEqual(
      ['badge', 'clubId', 'eventId', 'eventType', 'icon', 'message', 'notificationId', 'title', 'type', 'url'].sort(),
    );
    // Le titre sentinelle est un texte de notification légitime (pas un secret) : seule
    // la présence de champs *hors* de cette allowlist serait une fuite. On vérifie
    // en plus qu'aucun e-mail réaliste ne s'est glissé dans le payload sérialisé.
    expect(findRealisticPii(JSON.stringify(sentBody)).length).toBe(0);
  });

  it('ne contacte pas le prestataire de push quand le service est désactivé (défaut)', async () => {
    vi.stubEnv('WEB_PUSH_ENABLED', 'false');
    const { triggerPushForUser } = await import('@/lib/push/service');
    const db = {} as DataSource;
    await triggerPushForUser(db, 42, {
      notificationId: 'delivery-sentinel-2',
      type: 'assignment',
      title: 'x',
      message: sentinelEmail('should-not-be-sent'),
      eventType: null,
      eventId: null,
    });
    expect(pushMocks.sendNotification).not.toHaveBeenCalled();
  });
});
