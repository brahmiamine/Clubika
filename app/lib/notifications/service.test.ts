import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import type { UserEntity } from '@/lib/db/schemas';

let preferenceRecord: { payload: unknown } | null = null;
const saveNotification = vi.fn(async (..._args: unknown[]) => undefined);
const triggerPushForUser = vi.fn(async (..._args: unknown[]) => undefined);
const sendEmail = vi.fn(async (..._args: unknown[]) => undefined);
const sendWhatsAppNotification = vi.fn(async (..._args: unknown[]) => undefined);
const enqueueNotificationDelivery = vi.fn(async (_db: unknown, input: Record<string, unknown>, _idempotencyKey?: string) => ({ ...input, id: 'outbox-1', attempts: 0 }));
const markNotificationSent = vi.fn(async (..._args: unknown[]) => undefined);
const markNotificationFailed = vi.fn(async (..._args: unknown[]) => undefined);
const listDueNotificationDeliveries = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
let clubTenantActive = true;
const isClubTenantActive = vi.fn(async (..._args: unknown[]) => clubTenantActive);

vi.mock('@/lib/planning/records', () => ({
  getPlanningRecord: vi.fn(async () => preferenceRecord),
}));
vi.mock('@/lib/push/service', () => ({
  triggerPushForUser: (...args: unknown[]) => triggerPushForUser(...args),
}));
vi.mock('./email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));
vi.mock('./whatsapp', () => ({
  sendWhatsAppNotification: (...args: unknown[]) => sendWhatsAppNotification(...args),
}));
vi.mock('./outbox', () => ({
  enqueueNotificationDelivery: (...args: unknown[]) => enqueueNotificationDelivery(...(args as [unknown, Record<string, unknown>, string | undefined])),
  markNotificationSent: (...args: unknown[]) => markNotificationSent(...args),
  markNotificationFailed: (...args: unknown[]) => markNotificationFailed(...args),
  listDueNotificationDeliveries: (...args: unknown[]) => listDueNotificationDeliveries(...args),
}));
vi.mock('@/lib/auth/club-context', () => ({
  getCurrentClubId: () => 'afp',
}));
vi.mock('@/lib/db/club-tenants', () => ({
  isClubTenantActive: (...args: unknown[]) => isClubTenantActive(...args),
}));

import {
  createNotificationForUser,
  deliverEnqueuedNotifications,
  enqueueContactNotificationIntents,
  retryPendingNotifications,
} from './service';

function fakeDb(findOneBy: (...args: unknown[]) => unknown = async () => null): DataSource {
  return {
    getRepository: () => ({ save: saveNotification, findOneBy }),
  } as unknown as DataSource;
}

function fakeContactDb(find: (...args: unknown[]) => unknown): DataSource {
  return {
    getRepository: () => ({ save: saveNotification, find }),
  } as unknown as DataSource;
}

function fakeUser(overrides: Partial<UserEntity> = {}): UserEntity {
  return {
    id: 1,
    clubId: 'afp',
    email: 'user@example.com',
    nom: 'Test',
    accessRole: 'dirigeant',
    planningFunctions: ['arbitre_club'],
    active: true,
    notifyChannel: 'email',
    ...overrides,
  } as UserEntity;
}

describe('createNotificationForUser', () => {
  beforeEach(() => {
    preferenceRecord = null;
    saveNotification.mockClear();
    triggerPushForUser.mockClear();
    sendEmail.mockClear();
    sendWhatsAppNotification.mockClear();
    enqueueNotificationDelivery.mockClear();
  });

  it('creates the in-app notification and enqueues push even when user.notifyChannel is "email"', async () => {
    // Régression #162 : notifyChannel ne doit plus être un second filtre au-dessus des
    // préférences granulaires (préférences par défaut : inApp/push/email actifs).
    const db = fakeDb();
    const user = fakeUser({ notifyChannel: 'email' });

    await createNotificationForUser(db, user, { type: 'assignment', title: 'Affectation', message: 'Vous êtes affecté' });

    expect(saveNotification).toHaveBeenCalledTimes(1);
    const pushCalls = enqueueNotificationDelivery.mock.calls.filter(([, input]) => (input as { channel: string }).channel === 'push');
    expect(pushCalls).toHaveLength(1);
    const emailCalls = enqueueNotificationDelivery.mock.calls.filter(([, input]) => (input as { channel: string }).channel === 'email');
    expect(emailCalls).toHaveLength(1);
  });

  it('respects an explicit granular preference disabling in-app and push', async () => {
    preferenceRecord = { payload: { inApp: false, push: false, email: true, whatsapp: false } };
    const db = fakeDb();
    const user = fakeUser({ notifyChannel: 'push' });

    await createNotificationForUser(db, user, { type: 'assignment', title: 'Affectation', message: 'Vous êtes affecté' });

    expect(saveNotification).not.toHaveBeenCalled();
    const pushCalls = enqueueNotificationDelivery.mock.calls.filter(([, input]) => (input as { channel: string }).channel === 'push');
    expect(pushCalls).toHaveLength(0);
    const emailCalls = enqueueNotificationDelivery.mock.calls.filter(([, input]) => (input as { channel: string }).channel === 'email');
    expect(emailCalls).toHaveLength(1);
  });

  it('correlates each push with its unique outbox delivery', async () => {
    preferenceRecord = { payload: { inApp: true, push: true, email: false, whatsapp: false } };
    enqueueNotificationDelivery
      .mockResolvedValueOnce({
        id: 'delivery-1', userId: 1, channel: 'push', type: 'first', title: 'Première',
        message: 'Message 1', eventType: null, eventId: null, urgency: 'normal', attempts: 0,
      } as never)
      .mockResolvedValueOnce({
        id: 'delivery-2', userId: 1, channel: 'push', type: 'second', title: 'Deuxième',
        message: 'Message 2', eventType: null, eventId: null, urgency: 'normal', attempts: 0,
      } as never);
    const db = fakeDb();
    const user = fakeUser();

    await createNotificationForUser(db, user, { type: 'first', title: 'Première', message: 'Message 1' });
    await createNotificationForUser(db, user, { type: 'second', title: 'Deuxième', message: 'Message 2' });

    expect(saveNotification).toHaveBeenCalledTimes(2);
    expect(triggerPushForUser.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ notificationId: 'delivery-1', title: 'Première', url: '/mon-planning/notifications' }),
      expect.objectContaining({ notificationId: 'delivery-2', title: 'Deuxième', url: '/mon-planning/notifications' }),
    ]);
  });

  it('never throws when the in-app write fails — a notification failure must not fail the caller\'s successful command (issue #208)', async () => {
    saveNotification.mockRejectedValueOnce(new Error('DB indisponible'));
    const consoleError = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const db = fakeDb();
    const user = fakeUser();

    await expect(createNotificationForUser(db, user, { type: 'assignment', title: 'Affectation', message: 'Vous êtes affecté' }))
      .resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('never throws when a deferred channel fails to enqueue, and still attempts the other channels', async () => {
    preferenceRecord = { payload: { inApp: true, push: true, email: true, whatsapp: false } };
    enqueueNotificationDelivery
      .mockRejectedValueOnce(new Error('outbox indisponible'))
      .mockResolvedValueOnce({
        id: 'delivery-1', userId: 1, channel: 'email', type: 'assignment', title: 'Affectation',
        message: 'Vous êtes affecté', eventType: null, eventId: null, urgency: 'normal', attempts: 0,
      } as never);
    const consoleError = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const db = fakeDb();
    const user = fakeUser();

    await expect(createNotificationForUser(db, user, { type: 'assignment', title: 'Affectation', message: 'Vous êtes affecté' }))
      .resolves.toBeUndefined();

    expect(saveNotification).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('pointe le push vers l’espace événement, jamais vers /notifications (issue #321)', async () => {
    preferenceRecord = { payload: { inApp: true, push: true, email: false, whatsapp: false } };
    enqueueNotificationDelivery.mockResolvedValueOnce({
      id: 'delivery-evt', userId: 1, channel: 'push', type: 'planning-published-added', title: 'Nouvelle affectation',
      message: 'Vous êtes affecté', eventType: 'amical', eventId: 'm-1', urgency: 'normal', attempts: 0,
    } as never);
    await createNotificationForUser(fakeDb(), fakeUser({ accessRole: 'admin' }), {
      type: 'planning-published-added',
      title: 'Nouvelle affectation',
      message: 'Vous êtes affecté',
      eventType: 'amical',
      eventId: 'm-1',
    });
    expect(triggerPushForUser.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      url: '/club/evenements/amical/m-1?from=planning',
    }));
  });
});

describe('retryPendingNotifications (issue #215)', () => {
  const pendingItem = { id: 'outbox-1', userId: 1, channel: 'email' as const };

  beforeEach(() => {
    clubTenantActive = true;
    markNotificationFailed.mockClear();
    sendEmail.mockClear();
    markNotificationSent.mockClear();
    listDueNotificationDeliveries.mockClear();
    isClubTenantActive.mockClear();
    listDueNotificationDeliveries.mockResolvedValueOnce([pendingItem]);
  });

  it('abandons a due notification whose club has been disabled, without attempting delivery', async () => {
    clubTenantActive = false;
    const db = fakeDb(async () => fakeUser());

    const result = await retryPendingNotifications(db);

    expect(result.processed).toBe(1);
    expect(isClubTenantActive).toHaveBeenCalledWith(db, 'afp');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(markNotificationSent).not.toHaveBeenCalled();
    expect(markNotificationFailed).toHaveBeenCalledWith(db, 'outbox-1', 9, expect.any(Error));
  });

  it('delivers a due notification when the club is active', async () => {
    clubTenantActive = true;
    const db = fakeDb(async () => fakeUser());

    await retryPendingNotifications(db);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(markNotificationSent).toHaveBeenCalledWith(db, 'outbox-1');
    expect(markNotificationFailed).not.toHaveBeenCalled();
  });

  it('still abandons for an inactive user without even checking the club', async () => {
    const db = fakeDb(async () => fakeUser({ active: false }));

    await retryPendingNotifications(db);

    expect(isClubTenantActive).not.toHaveBeenCalled();
    expect(markNotificationFailed).toHaveBeenCalledWith(db, 'outbox-1', 9, expect.any(Error));
  });
});

describe('enqueueContactNotificationIntents / deliverEnqueuedNotifications (issue #276)', () => {
  beforeEach(() => {
    preferenceRecord = null;
    saveNotification.mockClear();
    triggerPushForUser.mockClear();
    sendEmail.mockClear();
    sendWhatsAppNotification.mockClear();
    enqueueNotificationDelivery.mockClear();
    markNotificationSent.mockClear();
  });

  it('persiste l’intention (ligne in-app + outbox) sans jamais tenter de livraison réseau', async () => {
    const manager = fakeContactDb(async () => [fakeUser({ id: 42 })]);

    const enqueued = await enqueueContactNotificationIntents(
      manager,
      { nom: 'Test', numero: '', personType: 'encadrant', personId: 42 },
      { type: 'planning-published-added', title: 'Nouvelle affectation', message: 'Vous êtes affecté' },
      'publish:before:amical:evt-1:encadrant:42:added',
    );

    expect(saveNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotificationDelivery).toHaveBeenCalled();
    // Aucune tentative de livraison réelle pendant l'étape d'enregistrement transactionnel :
    // c'est le non-but explicite de l'issue #276 (« Sending email/push inside the database
    // transaction »).
    expect(triggerPushForUser).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendWhatsAppNotification).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.user.id).toBe(42);
  });

  it('dérive une clé d’idempotence par canal à partir de la base fournie par l’appelant', async () => {
    preferenceRecord = { payload: { inApp: true, push: true, email: true, whatsapp: false } };
    const manager = fakeContactDb(async () => [fakeUser({ id: 42 })]);

    await enqueueContactNotificationIntents(
      manager,
      { nom: 'Test', numero: '', personType: 'encadrant', personId: 42 },
      { type: 'planning-published-added', title: 'Nouvelle affectation', message: 'Vous êtes affecté' },
      'publish:before:amical:evt-1:encadrant:42:added',
    );

    const keysByChannel = new Map(
      enqueueNotificationDelivery.mock.calls.map((call) => {
        const [, input, key] = call as [unknown, { channel: string }, string | undefined];
        return [input.channel, key] as const;
      }),
    );
    expect(keysByChannel.get('push')).toBe('publish:before:amical:evt-1:encadrant:42:added:42:push');
    expect(keysByChannel.get('email')).toBe('publish:before:amical:evt-1:encadrant:42:added:42:email');
  });

  it('livre après coup chaque intention déjà persistée, un échec par canal restant isolé', async () => {
    enqueueNotificationDelivery
      .mockResolvedValueOnce({
        id: 'outbox-push', userId: 42, channel: 'push', type: 'planning-published-added', title: 'T',
        message: 'M', eventType: null, eventId: null, urgency: 'normal', attempts: 0,
      } as never)
      .mockResolvedValueOnce({
        id: 'outbox-email', userId: 42, channel: 'email', type: 'planning-published-added', title: 'T',
        message: 'M', eventType: null, eventId: null, urgency: 'normal', attempts: 0,
      } as never);
    // `push` exige `inApp` actif dans normalizeNotificationPreferences (une notification
    // push sans son pendant in-app n'a pas de sens côté préférences) : inApp doit donc
    // rester actif ici pour que les deux canaux différés soient réellement sélectionnés.
    preferenceRecord = { payload: { inApp: true, push: true, email: true, whatsapp: false } };
    const manager = fakeContactDb(async () => [fakeUser({ id: 42 })]);

    const enqueued = await enqueueContactNotificationIntents(
      manager,
      { nom: 'Test', numero: '', personType: 'encadrant', personId: 42 },
      { type: 'planning-published-added', title: 'Nouvelle affectation', message: 'Vous êtes affecté' },
      'publish:before:amical:evt-1:encadrant:42:added',
    );
    expect(triggerPushForUser).not.toHaveBeenCalled();

    const db = fakeDb();
    await deliverEnqueuedNotifications(db, enqueued);

    expect(triggerPushForUser).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(markNotificationSent).toHaveBeenCalledTimes(2);
  });
});
