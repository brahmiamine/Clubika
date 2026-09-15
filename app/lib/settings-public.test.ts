import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@/lib/settings';
import {
  FORBIDDEN_PUBLIC_SETTINGS_KEYS,
  PUBLIC_CLUB_SETTINGS_KEYS,
  sanitizePublicClubLogo,
  toAdminClubSettings,
  toMemberClubSettings,
  toPublicClubSettings,
} from '@/lib/settings-public';

const fullSettings: AppSettings = {
  ...DEFAULT_APP_SETTINGS,
  clubName: 'Club de test',
  clubAbbreviation: 'CDT',
  clubDescription: 'Description interne du club',
  clubLogo: 'https://cdn.example.test/logo.png',
  primaryColor: '#0f766e',
  accentColor: '#f59e0b',
  themeMode: 'dark',
  timeZone: 'Europe/Paris',
  smtp: {
    host: 'smtp.example.test',
    port: 587,
    secure: false,
    user: 'smtp-user',
    fromEmail: 'noreply@example.test',
    fromName: 'Club de test',
    passwordSet: true,
  },
  features: {
    ...DEFAULT_APP_SETTINGS.features,
    travelAndWeather: false,
    scraperSync: false,
  },
  matchesUrlKey: 'secret-feed-key',
  scraperClubName: 'Internal scraper name',
};

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectKeys(nested, keys);
  }
  return keys;
}

describe('toPublicClubSettings', () => {
  it('exposes only declared branding fields', () => {
    const publicSettings = toPublicClubSettings(fullSettings);
    expect(Object.keys(publicSettings).sort()).toEqual([...PUBLIC_CLUB_SETTINGS_KEYS].sort());
    expect(publicSettings.clubName).toBe('Club de test');
    expect(publicSettings.primaryColor).toBe('#0f766e');
    expect(publicSettings.accentColor).toBe('#f59e0b');
  });

  it('strips remote club logos', () => {
    expect(toPublicClubSettings(fullSettings).clubLogo).toBe('');
  });

  it('never includes known secrets or internal fields', () => {
    const publicSettings = toPublicClubSettings(fullSettings);
    const keys = collectKeys(publicSettings);
    for (const key of FORBIDDEN_PUBLIC_SETTINGS_KEYS) {
      expect(keys.has(key)).toBe(false);
    }
    const json = JSON.stringify(publicSettings);
    expect(json).not.toContain('smtp-user');
    expect(json).not.toContain('secret-feed-key');
    expect(json).not.toContain('Internal scraper name');
    expect(json).not.toContain('smtp.example.test');
    expect(json).not.toContain('noreply@example.test');
    expect(json).not.toContain('Description interne');
  });

  it('does not change when extra AppSettings fields are added', () => {
    const withFutureField = {
      ...fullSettings,
      internalAdminFlag: true,
      secretWebhookUrl: 'https://internal.example.test/hook',
    } as AppSettings & { internalAdminFlag: boolean; secretWebhookUrl: string };

    const publicSettings = toPublicClubSettings(withFutureField);
    const json = JSON.stringify(publicSettings);
    expect(Object.keys(publicSettings).sort()).toEqual([...PUBLIC_CLUB_SETTINGS_KEYS].sort());
    expect(json).not.toContain('internalAdminFlag');
    expect(json).not.toContain('secretWebhookUrl');
    expect(json).not.toContain('internal.example.test');
  });
});

describe('sanitizePublicClubLogo', () => {
  it('keeps empty, same-origin, and data:image logos', () => {
    expect(sanitizePublicClubLogo('')).toBe('');
    expect(sanitizePublicClubLogo('/uploads/logo.png')).toBe('/uploads/logo.png');
    expect(sanitizePublicClubLogo('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
  });

  it('drops remote and unsafe values', () => {
    expect(sanitizePublicClubLogo('https://cdn.example.test/x.png')).toBe('');
    expect(sanitizePublicClubLogo('//evil.example.test/x.png')).toBe('');
    expect(sanitizePublicClubLogo('data:text/html;base64,PHNjcmlwdD4=')).toBe('');
    expect(sanitizePublicClubLogo('javascript:alert(1)')).toBe('');
  });
});

describe('toMemberClubSettings', () => {
  it('omits SMTP and scraping fields', () => {
    const member = toMemberClubSettings(fullSettings);
    expect(member).not.toHaveProperty('smtp');
    expect(member).not.toHaveProperty('matchesUrlKey');
    expect(member).not.toHaveProperty('scraperClubName');
    expect(member.features.travelAndWeather).toBe(false);
    expect(member.clubAbbreviation).toBe('CDT');
  });
});

describe('toAdminClubSettings', () => {
  it('never returns the SMTP password', () => {
    const admin = toAdminClubSettings(fullSettings);
    expect(admin.smtp.passwordSet).toBe(true);
    expect(admin.smtp).not.toHaveProperty('password');
    expect(JSON.stringify(admin)).not.toContain('"password":');
    expect(admin).not.toHaveProperty('matchesUrlKey');
    expect(admin).not.toHaveProperty('scraperClubName');
    expect(admin.smtp.user).toBe('smtp-user');
  });
});
