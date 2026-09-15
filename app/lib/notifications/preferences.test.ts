import { describe, expect, it } from 'vitest';
import { normalizeNotificationPreferences, selectedNotificationChannels } from './preferences';

describe('notification preferences', () => {
  it('defaults to durable in-app plus push/email and leaves WhatsApp opt-in', () => {
    const preferences = normalizeNotificationPreferences(null);
    expect(preferences).toMatchObject({ inApp: true, push: true, email: true, whatsapp: false });
    expect(selectedNotificationChannels(preferences, { urgency: 'normal', eventType: 'officiel' })).toEqual(['inApp', 'push', 'email']);
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
