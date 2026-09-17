import { describe, expect, it } from 'vitest';
import { normalizeNotificationPreferences, selectedNotificationChannels } from './preferences';

describe('notification preferences', () => {
  it('defaults to durable in-app only — every external channel is opt-in (issue #27)', () => {
    const preferences = normalizeNotificationPreferences(null);
    expect(preferences).toMatchObject({
      inApp: true,
      push: false,
      email: false,
      whatsapp: false,
      pushDetailedPreview: false,
      emailDetailedPreview: false,
    });
    expect(selectedNotificationChannels(preferences, { urgency: 'normal', eventType: 'officiel' })).toEqual(['inApp']);
  });

  it('activates push/email only with an explicit `=== true`, revocably (issue #27)', () => {
    const optedIn = normalizeNotificationPreferences({ inApp: true, push: true, email: true });
    expect(optedIn.push).toBe(true);
    expect(optedIn.email).toBe(true);
    expect(selectedNotificationChannels(optedIn, { urgency: 'normal' })).toEqual(['inApp', 'push', 'email']);

    // Retrait explicite et immédiat : repasser à `false` désactive à nouveau le canal.
    const revoked = normalizeNotificationPreferences({ inApp: true, push: false, email: false });
    expect(revoked.push).toBe(false);
    expect(revoked.email).toBe(false);
    expect(selectedNotificationChannels(revoked, { urgency: 'normal' })).toEqual(['inApp']);

    // Une valeur ambiguë (ni `true` ni `false`) ne doit jamais valoir opt-in.
    const ambiguous = normalizeNotificationPreferences({ inApp: true, push: 'yes', email: 1 });
    expect(ambiguous.push).toBe(false);
    expect(ambiguous.email).toBe(false);
  });

  it('l’aperçu détaillé est opt-in, granulaire par canal, et retombe à false si le canal est éteint (issue #27)', () => {
    const detailed = normalizeNotificationPreferences({
      inApp: true, push: true, email: true, pushDetailedPreview: true, emailDetailedPreview: true,
    });
    expect(detailed.pushDetailedPreview).toBe(true);
    expect(detailed.emailDetailedPreview).toBe(true);

    // Le canal push est éteint : son aperçu détaillé ne peut pas rester actif tout seul.
    const pushOff = normalizeNotificationPreferences({
      inApp: true, push: false, email: true, pushDetailedPreview: true, emailDetailedPreview: true,
    });
    expect(pushOff.pushDetailedPreview).toBe(false);
    expect(pushOff.emailDetailedPreview).toBe(true);

    expect(normalizeNotificationPreferences(null).pushDetailedPreview).toBe(false);
    expect(normalizeNotificationPreferences(null).emailDetailedPreview).toBe(false);
  });

  it('enables chat sounds by default, and only explicit `false` disables them (issue #269)', () => {
    expect(normalizeNotificationPreferences(null).chatSounds).toBe(true);
    expect(normalizeNotificationPreferences({}).chatSounds).toBe(true);
    expect(normalizeNotificationPreferences({ chatSounds: false }).chatSounds).toBe(false);
    expect(normalizeNotificationPreferences({ chatSounds: true }).chatSounds).toBe(true);
    expect(normalizeNotificationPreferences({ chatSounds: 'nope' }).chatSounds).toBe(true);
  });

  it('applies urgency threshold and event type filters to secondary channels', () => {
    const preferences = normalizeNotificationPreferences({
      inApp: true,
      push: true,
      email: false,
      whatsapp: true,
      urgencyThreshold: 'important',
      eventTypes: ['officiel'],
    });
    expect(selectedNotificationChannels(preferences, { urgency: 'normal', eventType: 'officiel' })).toEqual(['inApp']);
    expect(selectedNotificationChannels(preferences, { urgency: 'critical', eventType: 'officiel' })).toEqual(['inApp', 'push', 'whatsapp']);
    expect(selectedNotificationChannels(preferences, { urgency: 'critical', eventType: 'plateau' })).toEqual(['inApp']);
  });

  it('ne sélectionne WhatsApp qu’avec un opt-in explicite (issue #17)', () => {
    const optedOut = normalizeNotificationPreferences({ whatsapp: false });
    expect(optedOut.whatsapp).toBe(false);
    expect(selectedNotificationChannels(optedOut, { urgency: 'critical' })).not.toContain('whatsapp');
    const optedIn = normalizeNotificationPreferences({ whatsapp: true });
    expect(optedIn.whatsapp).toBe(true);
    expect(selectedNotificationChannels(optedIn, { urgency: 'critical' })).toContain('whatsapp');
  });
});
