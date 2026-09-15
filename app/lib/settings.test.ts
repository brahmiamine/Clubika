import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  pickClubWritableSettings,
  roleLabelWithClub,
} from './settings';

describe('normalizeAppSettings planning features', () => {
  it('keeps safe defaults when feature settings are missing', () => {
    const settings = normalizeAppSettings({ clubName: 'AFP' });

    expect(settings.features).toEqual(DEFAULT_APP_SETTINGS.features);
    expect(settings.timeZone).toBe(DEFAULT_APP_SETTINGS.timeZone);
    expect(settings.features.publicationReadiness).toBe(false);
    expect(settings.features.scraperSync).toBe(false);
    expect(settings.features.officialMatchesCurrentWeekendOnly).toBe(true);
  });

  it('preserves explicit feature switches and rejects non booleans', () => {
    const settings = normalizeAppSettings({
      features: {
        recurringEvents: false,
        scraperSync: false,
        eventChat: 'false',
      },
    });

    expect(settings.features.recurringEvents).toBe(false);
    expect(settings.features.scraperSync).toBe(false);
    expect(settings.features.eventChat).toBe(DEFAULT_APP_SETTINGS.features.eventChat);
  });

  it('falls back when the configured time zone is invalid', () => {
    expect(normalizeAppSettings({ timeZone: 'Europe/Paris' }).timeZone).toBe('Europe/Paris');
    expect(normalizeAppSettings({ timeZone: 'Mars/Olympus' }).timeZone).toBe(DEFAULT_APP_SETTINGS.timeZone);
  });
});

describe('normalizeAppSettings clubAbbreviation', () => {
  it('uses the default abbreviation when the key is missing', () => {
    expect(normalizeAppSettings({ clubName: 'Club X' }).clubAbbreviation).toBe(DEFAULT_APP_SETTINGS.clubAbbreviation);
    expect(DEFAULT_APP_SETTINGS.clubAbbreviation).toBe('AFP');
  });

  it('trims, collapses whitespace and caps the length', () => {
    expect(normalizeAppSettings({ clubAbbreviation: '  RC  Lens  ' }).clubAbbreviation).toBe('RC Lens');
    expect(normalizeAppSettings({ clubAbbreviation: 'A'.repeat(40) }).clubAbbreviation).toHaveLength(16);
  });

  it('keeps an explicit empty string so the UI can flag it as required', () => {
    expect(normalizeAppSettings({ clubAbbreviation: '   ' }).clubAbbreviation).toBe('');
  });
});

describe('normalizeAppSettings smtp.passwordSet', () => {
  it('preserves a boolean passwordSet flag from stored settings', () => {
    expect(normalizeAppSettings({
      smtp: { host: 'smtp.example.test', passwordSet: true },
    }).smtp.passwordSet).toBe(true);
    expect(normalizeAppSettings({
      smtp: { host: 'smtp.example.test' },
    }).smtp.passwordSet).toBe(false);
  });
});

describe('pickClubWritableSettings', () => {
  it('retire matchesUrlKey et scraperClubName du payload club', () => {
    const writable = pickClubWritableSettings({
      ...DEFAULT_APP_SETTINGS,
      matchesUrlKey: 'should-not-leave-the-client',
      scraperClubName: 'Should Not Leave The Client',
    });

    expect(writable).not.toHaveProperty('matchesUrlKey');
    expect(writable).not.toHaveProperty('scraperClubName');
    expect(writable.clubName).toBe(DEFAULT_APP_SETTINGS.clubName);
    expect(writable.features).toEqual(DEFAULT_APP_SETTINGS.features);
  });
});

describe('roleLabelWithClub', () => {
  it('suffixes the base label with the abbreviation', () => {
    expect(roleLabelWithClub('Arbitre', 'AFP')).toBe('Arbitre AFP');
    expect(roleLabelWithClub('Encadrants', ' RCL ')).toBe('Encadrants RCL');
  });

  it('returns the bare label when the abbreviation is empty', () => {
    expect(roleLabelWithClub('Arbitre', '')).toBe('Arbitre');
    expect(roleLabelWithClub('Accompagnateur', '   ')).toBe('Accompagnateur');
  });
});
