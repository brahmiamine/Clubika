import { describe, expect, it } from 'vitest';
import { TENANT_STORES, purgableStores } from './inventory';
import { platformClubWriteBlocked } from './writable';
import { parseRetentionUntil } from './dates';
import { assertPurgeAllowed } from './purge';
import { OffboardingError } from './errors';
import { hashClubId, PRIVACY_NO_LEGAL_PROMISE } from './constants';
import type { ClubTenantEntity } from '@/lib/db/schemas';

describe('tenant offboarding inventory (issue #25)', () => {
  it('couvre les tables métier, BLOB, capacités et le stockage documenté hors tenant', () => {
    const ids = TENANT_STORES.map((store) => store.id);
    expect(ids).toEqual(expect.arrayContaining([
      'planning_attachments',
      'chat_attachments',
      'users',
      'user_sessions',
      'invitations',
      'push_subscriptions',
      'password_reset_tokens',
      'match_audit_log',
      'club_tenants',
      'backups',
      'platform_admins',
    ]));
    expect(TENANT_STORES.filter((store) => store.blob).map((store) => store.id)).toEqual([
      'planning_attachments',
      'chat_attachments',
    ]);
    expect(purgableStores().some((store) => store.id === 'platform_admins')).toBe(false);
    expect(purgableStores().some((store) => store.keepAfterPurge)).toBe(false);
  });

  it('ne présente pas la notice comme une obligation légale calculée', () => {
    expect(PRIVACY_NO_LEGAL_PROMISE.toLowerCase()).toContain('pas un avis juridique');
    expect(hashClubId('club-a')).not.toBe(hashClubId('club-b'));
  });
});

function tenant(overrides: Partial<ClubTenantEntity>): ClubTenantEntity {
  return {
    id: 'demo',
    name: 'Demo',
    abbreviation: 'D',
    description: '',
    logo: '',
    themeMode: 'system',
    primaryColor: '#000000',
    secondaryColor: '#ffffff',
    timeZone: 'Europe/Paris',
    matchesUrlKey: '',
    scraperClubName: '',
    featuresJson: '{}',
    smtpHost: null,
    smtpPort: null,
    smtpSecure: false,
    smtpUser: null,
    smtpPasswordEncrypted: null,
    smtpFromEmail: null,
    smtpFromName: null,
    active: false,
    offboardingStatus: 'none',
    frozenAt: null,
    retentionUntil: null,
    purgedAt: null,
    legalHoldActive: false,
    legalHoldMotive: null,
    legalHoldScope: null,
    legalHoldExpiresAt: null,
    legalHoldApprovedBy: null,
    legalHoldCreatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('tenant offboarding gates (issue #25)', () => {
  it('bloque les écritures plateforme dès le gel ou le legal hold', () => {
    expect(platformClubWriteBlocked(tenant({ offboardingStatus: 'none' }))).toBeNull();
    expect(platformClubWriteBlocked(tenant({ offboardingStatus: 'frozen' }))).toMatch(/gelé/i);
    expect(platformClubWriteBlocked(tenant({ legalHoldActive: true }))).toMatch(/legal hold/i);
    expect(platformClubWriteBlocked(tenant({ offboardingStatus: 'purged' }))).toMatch(/supprimé/i);
  });

  it('refuse une purge avant gel, sous legal hold, ou avant la rétention produit', () => {
    expect(() => assertPurgeAllowed(tenant({ offboardingStatus: 'none' }), { overrideRetention: false }))
      .toThrow(OffboardingError);
    expect(() => assertPurgeAllowed(tenant({ offboardingStatus: 'frozen', legalHoldActive: true }), { overrideRetention: true }))
      .toThrow(/legal hold/i);
    const future = new Date(Date.now() + 86400000);
    expect(() => assertPurgeAllowed(tenant({ offboardingStatus: 'frozen', retentionUntil: future }), { overrideRetention: false }))
      .toThrow(/rétention/i);
    expect(() => assertPurgeAllowed(
      tenant({ offboardingStatus: 'frozen', retentionUntil: future }),
      { overrideRetention: true },
    )).not.toThrow();
  });

  it('parse une date de rétention produit sans inventer de délai légal', () => {
    expect(parseRetentionUntil(null)).toBeNull();
    expect(parseRetentionUntil(new Date(Date.now() + 3600000).toISOString())?.getTime()).toBeGreaterThan(Date.now());
    expect(() => parseRetentionUntil('not-a-date')).toThrow(OffboardingError);
  });
});
