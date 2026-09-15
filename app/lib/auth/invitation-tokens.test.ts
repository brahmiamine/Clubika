import { describe, expect, it } from 'vitest';
import {
  hashInvitationToken,
  maskEmail,
  newInvitationToken,
  padToMinimumDuration,
  resolveInvitationLookupId,
} from './invitation-tokens';

describe('invitation tokens', () => {
  it('émet un jeton hex de 48 caractères distinct d’une empreinte SHA-256', () => {
    const token = newInvitationToken();
    expect(token).toMatch(/^[a-f0-9]{48}$/);
    expect(hashInvitationToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(token).not.toBe(hashInvitationToken(token));
  });

  it('résout un id déjà hashé sans le re-hacher', () => {
    const token = newInvitationToken();
    const hashed = hashInvitationToken(token);
    expect(resolveInvitationLookupId(hashed)).toBe(hashed);
    expect(resolveInvitationLookupId(token)).toBe(hashed);
  });
});

describe('maskEmail (issue #34)', () => {
  it('ne révèle jamais l’adresse complète', () => {
    expect(maskEmail('alice.martin@club-exemple.fr')).toBe('a***@c***.fr');
    expect(maskEmail('A@B.co.uk')).toBe('a***@b***.uk');
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail('')).toBeNull();
    const masked = maskEmail('invitee@example.com');
    expect(masked).not.toContain('invitee');
    expect(masked).not.toContain('example.com');
  });
});

describe('padToMinimumDuration', () => {
  it('attend le reliquat si le travail a été plus court que le plancher', async () => {
    const started = Date.now();
    await padToMinimumDuration(started, 25);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('ne prolonge pas un travail déjà plus long que le plancher', async () => {
    const started = Date.now() - 50;
    const before = Date.now();
    await padToMinimumDuration(started, 25);
    expect(Date.now() - before).toBeLessThan(20);
  });
});
