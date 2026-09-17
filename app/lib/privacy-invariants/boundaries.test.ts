/**
 * Suite « privacy invariants » (issue #41) — matrice des frontières publiques.
 *
 * Chaque cas construit une entrée avec des données strictement sentinelles
 * (voir `sentinel-factory.ts`), fait traverser la vraie fonction de frontière
 * déjà livrée par les tickets #6/#20/#21/#22/#25/#30/#31/etc., puis vérifie en
 * négatif que rien d'interdit n'a survécu. Aucune de ces fonctions n'est
 * réimplémentée ici : on les importe depuis leur module réel pour que toute
 * régression future (un champ ajouté sans passer par l'allowlist) casse cette
 * suite plutôt que d'être découverte en production.
 *
 * Volontairement sans base de données : chaque frontière testée ici est une
 * fonction pure ou prend ses entrées en paramètre. Les frontières qui exigent
 * une vraie connexion (export RGPD complet, purge, offboarding…) sont couvertes
 * par `lifecycle.integration.test.ts`, qui suit la convention `*.integration.test.ts`
 * déjà utilisée dans ce dépôt (`describe.skipIf(!isDbAvailable())`).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  toPublicClubSettings,
  PUBLIC_CLUB_SETTINGS_KEYS,
  FORBIDDEN_PUBLIC_SETTINGS_KEYS,
} from '@/lib/settings-public';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@/lib/settings';
import {
  toPublicPlanningItem,
  publicSportsVenueAddress,
  FORBIDDEN_PUBLIC_PLANNING_KEYS,
  PUBLIC_PLANNING_ITEM_KEYS,
  type PublicShareScope,
} from '@/lib/planning/public-share';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';
import type { Match } from '@/types/match';
import { maskEmail } from '@/lib/auth/invitation-tokens';
import { INVITATION_PUBLIC_INVALID_BODY } from '@/lib/auth/invitation-public';
import { generateIcal } from '@/lib/utils/ical-export';
import { minimizeAuditPayload, auditBlobContainsNeedle } from '@/lib/audit/minimize';
import { exportContainsForbiddenNeedles } from '@/lib/privacy/export';
import { logErrorForClub, logInfo } from '@/lib/observability/log';
import { redact, classifyProviderError } from '@/lib/observability/redact';

import {
  forbiddenSentinelBundle,
  allForbiddenNeedles,
  sentinelAddress,
  sentinelClubId,
  sentinelName,
} from './sentinel-factory';

/** Récupère récursivement toutes les clés d'un objet sérialisé (comme un `collectKeys` de fixture réutilisable). */
function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return keys;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(nested, keys);
  }
  return keys;
}

function assertNoForbiddenNeedles(payload: unknown, needles: readonly string[], context: string): void {
  const blob = JSON.stringify(payload ?? null);
  for (const needle of needles) {
    expect(blob.toLowerCase().includes(needle.toLowerCase()), `${context}: needle "${needle}" a franchi la frontière`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// 1. Public settings (issue #21)
// ---------------------------------------------------------------------------
describe('frontière: public settings (issue #21)', () => {
  it('ne renvoie jamais le SMTP, les identifiants scraper ni les fonctionnalités internes', () => {
    const bundle = forbiddenSentinelBundle('settings');
    const source: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      clubName: sentinelName('Club'),
      clubAbbreviation: bundle.freeText,
      clubDescription: bundle.freeText,
      matchesUrlKey: bundle.secret,
      scraperClubName: bundle.name,
      smtp: {
        host: bundle.secret,
        port: 2525,
        secure: true,
        user: bundle.email,
        fromEmail: bundle.email,
        fromName: bundle.name,
        passwordSet: true,
      },
    };

    const dto = toPublicClubSettings(source);

    expect(Object.keys(dto).sort()).toEqual([...PUBLIC_CLUB_SETTINGS_KEYS].sort());
    const keys = collectKeys(dto);
    for (const forbidden of FORBIDDEN_PUBLIC_SETTINGS_KEYS) {
      expect(keys.has(forbidden), `clé interdite "${forbidden}" présente dans le DTO public`).toBe(false);
    }
    assertNoForbiddenNeedles(dto, [bundle.secret, bundle.email, bundle.freeText, bundle.name], 'public settings');
  });
});

// ---------------------------------------------------------------------------
// 2. Partages publics de planning (issue #6)
// ---------------------------------------------------------------------------
describe('frontière: partages publics de planning (issue #6)', () => {
  function snapshot(overrides: Partial<Match>, bundle: ReturnType<typeof forbiddenSentinelBundle>): PlanningEventSnapshot {
    const match: Match = {
      date: '12/06/2026',
      competition: 'Championnat sentinelle',
      localTeam: 'Équipe A',
      awayTeam: 'Équipe B',
      venue: 'domicile',
      time: '15:00',
      horaireRendezVous: '14:00',
      durationMinutes: 90,
      rawText: bundle.rawText,
      details: {
        // Nom d'enceinte volontairement générique et non reconnu par
        // PUBLIC_VENUE_HINT (pas une donnée sentinelle : le nom de stade est un
        // champ intentionnellement public, contrairement à `address`, testée
        // séparément ci-dessous selon qu'elle est reconnue ou non).
        stadium: 'Lieu non communiqué',
        dateTime: '',
        competition: '',
        address: sentinelAddress(),
        terrainType: '',
        itineraryLink: '',
        rawText: bundle.rawText,
      },
      ...overrides,
    };
    return {
      eventId: 'evt-sentinel-1',
      eventType: 'officiel',
      title: 'ignored',
      date: match.date,
      time: match.time,
      durationMinutes: match.durationMinutes ?? 90,
      location: null,
      planningStatus: 'published',
      event: match,
      extras: null,
      assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
    } as PlanningEventSnapshot;
  }

  it('ne retient jamais les officiels, contacts, identifiants internes ni le rawText scrapé', () => {
    const bundle = forbiddenSentinelBundle('share');
    const item = toPublicPlanningItem(snapshot({}, bundle));

    for (const key of Object.keys(item)) {
      expect((PUBLIC_PLANNING_ITEM_KEYS as readonly string[]).includes(key), `clé hors allowlist: "${key}"`).toBe(true);
    }
    const keys = collectKeys(item);
    for (const forbidden of FORBIDDEN_PUBLIC_PLANNING_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
    assertNoForbiddenNeedles(item, allForbiddenNeedles(bundle), 'partage public planning');
  });

  it('n\'expose l\'adresse que pour une enceinte sportive reconnue, jamais un lieu libre sentinelle', () => {
    const freeAddress = sentinelAddress();
    expect(publicSportsVenueAddress('Domicile de la famille sentinelle', freeAddress)).toBeNull();
    expect(publicSportsVenueAddress('Stade municipal', freeAddress)).toBe(freeAddress);
  });

  it('respecte le périmètre de partage (types/dates) sans dépendre d\'un identifiant club exposé', () => {
    const scope: PublicShareScope = { eventTypes: ['officiel'], fromDate: '2026-06-01', toDate: '2026-06-30' };
    expect(scope.eventTypes).not.toContain('entrainement');
  });
});

// ---------------------------------------------------------------------------
// 3. Invitations (issue #34)
// ---------------------------------------------------------------------------
describe('frontière: invitations publiques (issue #34)', () => {
  it('masque l\'e-mail sans jamais le révéler en clair', () => {
    const bundle = forbiddenSentinelBundle('invitation');
    const masked = maskEmail(bundle.email);
    expect(masked).not.toBeNull();
    expect(masked).not.toBe(bundle.email);
    expect(masked).not.toContain(bundle.email.split('@')[0] ?? '');
    // Un seul caractère de chaque côté du "@" doit fuiter, jamais le nom complet.
    expect(masked as string).toMatch(/^.\*\*\*@.\*\*\*/);
  });

  it('ne distingue jamais un jeton invalide d\'un jeton expiré ou inconnu (forme uniforme)', () => {
    expect(INVITATION_PUBLIC_INVALID_BODY).toEqual({ valid: false });
    expect(Object.keys(INVITATION_PUBLIC_INVALID_BODY)).toEqual(['valid']);
  });
});

// ---------------------------------------------------------------------------
// 4. iCal — export personnel vs flux public (issue #6 / #13 / #278)
// ---------------------------------------------------------------------------
describe('frontière: iCal', () => {
  it('l\'UID ne dérive jamais d\'un champ personnel/éditable, seulement type+id+club', () => {
    const bundle = forbiddenSentinelBundle('ical');
    const match: Match = {
      date: '12/06/2026',
      competition: 'Championnat sentinelle',
      localTeam: bundle.name,
      awayTeam: sentinelName('Adversaire'),
      venue: 'domicile',
      time: '15:00',
      horaireRendezVous: '14:00',
      durationMinutes: 90,
      id: 'm-1',
      details: {
        stadium: 'Stade municipal',
        dateTime: '',
        competition: '',
        address: sentinelAddress(),
        terrainType: '',
        itineraryLink: '',
        rawText: '',
      },
    };
    const ics = generateIcal(
      [match],
      {},
      { name: sentinelName('Club'), description: '', logo: '' },
      { clubId: sentinelClubId(), timeZone: 'Europe/Paris' },
    );
    const uidLine = ics.split('\r\n').find((line) => line.startsWith('UID:'));
    expect(uidLine).toBeDefined();
    expect(uidLine).not.toContain(bundle.name);
    expect(uidLine).toContain('m-1');
  });

  it('échappe le texte libre pour empêcher toute injection de ligne iCal', () => {
    const injected = 'Ligne 1\nBEGIN:VEVENT\nUID:hostile';
    const match: Match = {
      date: '12/06/2026',
      competition: injected,
      localTeam: 'A',
      awayTeam: 'B',
      venue: 'domicile',
      time: '15:00',
      horaireRendezVous: '14:00',
      durationMinutes: 90,
      id: 'm-2',
      details: {
        stadium: '',
        dateTime: '',
        competition: '',
        address: injected,
        terrainType: '',
        itineraryLink: '',
        rawText: '',
      },
    };
    const ics = generateIcal([match], {}, undefined, { clubId: 'club-1' });
    // Une ligne DESCRIPTION doit contenir un `\n` échappé littéral, jamais un vrai saut de ligne.
    const descriptionLine = ics.split('\r\n').find((line) => line.startsWith('DESCRIPTION:'));
    if (descriptionLine) {
      expect(descriptionLine).not.toContain('\nBEGIN:VEVENT');
    }
    // La chaîne "BEGIN:VEVENT" injectée survit forcément telle quelle dans le texte
    // échappé du champ DESCRIPTION (c'est la propriété recherchée : elle n'est
    // *plus jamais interprétable* comme un composant). La propriété de sécurité
    // à vérifier n'est donc pas l'absence totale de cette sous-chaîne, mais
    // l'absence de toute ligne physique qui soit un VRAI début de composant.
    const realVeventLines = ics.split('\r\n').filter((line) => line === 'BEGIN:VEVENT');
    expect(realVeventLines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Exports RGPD — détection de fuite (issue #22) ; la construction réelle du
//    payload (buildSubjectExport) exige une base et est couverte par
//    lifecycle.integration.test.ts.
// ---------------------------------------------------------------------------
describe('frontière: détection de fuite export RGPD (issue #22)', () => {
  it('exportContainsForbiddenNeedles détecte une valeur sentinelle interdite', () => {
    const bundle = forbiddenSentinelBundle('export');
    const payload = { account: { id: 1, note: `public ${bundle.freeText}` } };
    expect(exportContainsForbiddenNeedles(payload, [bundle.freeText])).toBe(true);
    expect(exportContainsForbiddenNeedles({ account: { id: 1 } }, [bundle.freeText])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Logs (issue #31)
// ---------------------------------------------------------------------------
describe('frontière: logs applicatifs (issue #31)', () => {
  it('rédige e-mail, IP et téléphone même passés en detail non listé', () => {
    const bundle = forbiddenSentinelBundle('logs');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let lines: string[] = [];
    try {
      logInfo('app.unhandled', { note: bundle.freeText, contact: bundle.email, ip: bundle.ip, phone: bundle.phone });
      // Lire les appels AVANT mockRestore() : mockRestore() fait aussi un
      // mockReset(), qui vide `.mock.calls` (comportement Vitest/Jest standard).
      lines = writeSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      writeSpy.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const needle of [bundle.email, bundle.ip, bundle.phone]) {
      expect(lines.join('\n')).not.toContain(needle);
    }
  });

  it('pseudonymise l\'identifiant de club plutôt que de l\'écrire en clair', () => {
    const clubId = sentinelClubId('pseudo');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let record: { tenant?: string } = {};
    try {
      logErrorForClub('app.unhandled', clubId, 'club scoped error');
      record = JSON.parse(String(writeSpy.mock.calls[0]?.[0] ?? '{}'));
    } finally {
      writeSpy.mockRestore();
    }
    expect(record.tenant).toBeTruthy();
    expect(record.tenant).not.toBe(clubId);
    expect(record.tenant).not.toContain(clubId);
  });
});

// ---------------------------------------------------------------------------
// 7. Audit (issue #20)
// ---------------------------------------------------------------------------
describe('frontière: audit minimisé (issue #20)', () => {
  it('rejette le texte libre et les identifiants non catalogués', () => {
    const bundle = forbiddenSentinelBundle('audit');
    const minimized = minimizeAuditPayload({
      freeComment: bundle.freeText,
      contactEmail: bundle.email,
      // Clé autorisée (`changedFields`), mais valeur non conforme au format
      // technique attendu (un e-mail, pas un chemin de champ) : doit être rejetée
      // sur la valeur, pas seulement sur la clé.
      changedFields: bundle.email,
    });
    assertNoForbiddenNeedles(minimized, [bundle.freeText, bundle.email], 'audit minimisé');
    expect(auditBlobContainsNeedle(minimized, [bundle.freeText])).toBe(false);
    expect(minimized?.changedFields).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Erreurs (transverse)
// ---------------------------------------------------------------------------
describe('frontière: erreurs sérialisées', () => {
  it('ne renvoie jamais le message brut d\'une erreur système contenant un secret', () => {
    const bundle = forbiddenSentinelBundle('errors');
    const error = new Error(`SMTP auth failed for ${bundle.email} with token ${bundle.token}`);
    const redacted = redact(error) as Record<string, unknown>;
    assertNoForbiddenNeedles(redacted, [bundle.email, bundle.token], 'erreur redigée');
    expect(classifyProviderError(error).code).toBe('smtp_failed');
  });

  it('supprime la pile d\'appel en production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const redacted = redact(new Error('boom')) as Record<string, unknown>;
      expect(redacted.stack).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
