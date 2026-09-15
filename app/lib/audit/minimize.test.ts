import { describe, expect, it } from 'vitest';
import { AUDIT_CATALOG_VERSION, auditActorLabel, isAllowedAuditKey, isDeniedAuditKey } from './catalog';
import { auditBlobContainsNeedle, minimizeAuditPayload } from './minimize';
import { toAuditLogDto } from './dto';
import type { MatchAuditLogEntity } from '@/lib/db/schemas';

const SENTINEL_EMAIL = 'sentinel.audit@example.test';
const SENTINEL_PHONE = '0612345678';
const SENTINEL_NAME = 'Sentinel Person';
const SENTINEL_TEXT = 'Rapport confidentiel de test';
const SENTINEL_TOKEN = 'tok_live_secret_value';
const SENTINEL_FILE = 'passeport-jean.pdf';
const SENTINEL_REASON = 'Je ne peux pas venir mardi';
const NEEDLES = [
  SENTINEL_EMAIL,
  SENTINEL_PHONE,
  SENTINEL_NAME,
  SENTINEL_TEXT,
  SENTINEL_TOKEN,
  SENTINEL_FILE,
  SENTINEL_REASON,
];

function dirtySnapshot(): Record<string, unknown> {
  return {
    id: 'match-1',
    date: '15/09/2026',
    time: '18:00',
    confirmed: true,
    nom: SENTINEL_NAME,
    email: SENTINEL_EMAIL,
    telephone: SENTINEL_PHONE,
    note: SENTINEL_TEXT,
    text: SENTINEL_TEXT,
    comment: SENTINEL_TEXT,
    declineReason: 'personal',
    declineComment: SENTINEL_REASON,
    rawText: SENTINEL_TEXT,
    fileName: SENTINEL_FILE,
    token: SENTINEL_TOKEN,
    signedUrl: `https://cdn.example.test/file?signature=${SENTINEL_TOKEN}`,
    localTeam: SENTINEL_NAME,
    details: { stadium: 'Stade test', rawText: SENTINEL_TEXT, address: '1 rue test' },
    contacts: [
      {
        nom: SENTINEL_NAME,
        numero: SENTINEL_PHONE,
        personId: 42,
        personType: 'encadrant',
        status: 'accepted',
        declineComment: SENTINEL_REASON,
      },
    ],
    sourceOverride: {
      active: true,
      changedFields: ['date', 'time', 'details.stadium'],
      source: { localTeam: SENTINEL_NAME, rawText: SENTINEL_TEXT },
    },
    authorName: SENTINEL_NAME,
    authorUserId: 7,
    category: 'other',
  };
}

describe('catalogue d’audit v1 (issue #20)', () => {
  it('expose une version figée', () => {
    expect(AUDIT_CATALOG_VERSION).toBe(1);
  });

  it('refuse les clés nominatives et de contenu', () => {
    expect(isDeniedAuditKey('userEmail')).toBe(true);
    expect(isDeniedAuditKey('decline_comment')).toBe(true);
    expect(isDeniedAuditKey('fileName')).toBe(true);
    expect(isAllowedAuditKey('nom')).toBe(false);
    expect(isAllowedAuditKey('confirmed')).toBe(true);
    expect(isAllowedAuditKey('sourceOverride')).toBe(true);
  });

  it('pseudonymise l’acteur', () => {
    expect(auditActorLabel(null)).toBe('Système');
    expect(auditActorLabel(12)).toBe('Utilisateur #12');
  });
});

describe('minimizeAuditPayload (issue #20)', () => {
  it('ne laisse passer aucune valeur sentinelle interdite', () => {
    const minimized = minimizeAuditPayload(dirtySnapshot());
    expect(minimized).toMatchObject({
      id: 'match-1',
      date: '15/09/2026',
      time: '18:00',
      confirmed: true,
      authorUserId: 7,
      category: 'other',
      sourceOverride: {
        active: true,
        changedFields: ['date', 'time', 'details.stadium'],
      },
      contacts: [
        { personId: 42, personType: 'encadrant', status: 'accepted' },
      ],
    });
    expect(minimized).not.toHaveProperty('nom');
    expect(minimized).not.toHaveProperty('email');
    expect(minimized?.sourceOverride).not.toHaveProperty('source');
    expect(auditBlobContainsNeedle(minimized, NEEDLES)).toBe(false);
  });

  it('supprime un payload réduit à du contenu interdit', () => {
    expect(minimizeAuditPayload({
      nom: SENTINEL_NAME,
      email: SENTINEL_EMAIL,
      text: SENTINEL_TEXT,
      fileName: SENTINEL_FILE,
    })).toBeNull();
  });

  it('conserve les compteurs de publication sans titres', () => {
    const minimized = minimizeAuditPayload({
      publishedAt: '2026-09-15T18:00:00.000Z',
      events: 3,
      diff: {
        added: 1,
        removed: 1,
        removedEvents: [{ eventType: 'amical', eventId: 'm-1', title: SENTINEL_NAME, date: '16/09/2026' }],
      },
    });
    expect(minimized).toEqual({
      publishedAt: '2026-09-15T18:00:00.000Z',
      events: 3,
      diff: {
        added: 1,
        removed: 1,
        removedEvents: [{ eventType: 'amical', eventId: 'm-1', date: '16/09/2026' }],
      },
    });
    expect(auditBlobContainsNeedle(minimized, [SENTINEL_NAME])).toBe(false);
  });
});

describe('toAuditLogDto (issue #20)', () => {
  it('n’expose ni e-mail ni nom et réapplique la minimisation', () => {
    const entry: MatchAuditLogEntity = {
      id: 9,
      clubId: 'club-a',
      entityType: 'PlanningCollaboration',
      entityId: 'report-1',
      action: 'report',
      userId: 3,
      userEmail: SENTINEL_EMAIL,
      userNom: SENTINEL_NAME,
      before: null,
      after: { text: SENTINEL_TEXT, category: 'other', authorUserId: 3, authorName: SENTINEL_NAME },
      createdAt: new Date('2026-09-15T08:00:00.000Z'),
    };
    const dto = toAuditLogDto(entry);
    expect(dto.actorLabel).toBe('Utilisateur #3');
    expect(dto).not.toHaveProperty('userEmail');
    expect(dto).not.toHaveProperty('userNom');
    expect(dto.after).toEqual({ category: 'other', authorUserId: 3 });
    expect(dto.schemaVersion).toBe(1);
    expect(auditBlobContainsNeedle(dto, NEEDLES)).toBe(false);
  });
});
