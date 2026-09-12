import { describe, it, expect } from 'vitest';
import { generateIcal } from './ical-export';
import { Match, Entrainement } from '@/types/match';
import { MatchExtras } from '@/hooks/useMatchExtras';

function makeMatch(overrides: Partial<Match>): Match {
  return {
    id: 'match-1',
    date: '20/01/2026',
    time: '10:00',
    competition: 'D1',
    localTeam: 'Equipe A',
    awayTeam: 'Equipe B',
    venue: 'domicile',
    horaireRendezVous: '09:30',
    ...overrides,
  } as Match;
}

function durationFromIcal(ics: string): number {
  const dtstartMatch = ics.match(/DTSTART:(\d{8}T\d{6}Z)/);
  const dtendMatch = ics.match(/DTEND:(\d{8}T\d{6}Z)/);
  expect(dtstartMatch).toBeTruthy();
  expect(dtendMatch).toBeTruthy();

  const parseStamp = (stamp: string) =>
    Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(9, 11)),
      Number(stamp.slice(11, 13)),
    );

  return (parseStamp(dtendMatch![1]!) - parseStamp(dtstartMatch![1]!)) / 60000;
}

describe('generateIcal', () => {
  it('produces a valid VCALENDAR with balanced VEVENT blocks', () => {
    const match = makeMatch({});
    const ics = generateIcal([match], {});

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect((ics.match(/BEGIN:VEVENT/g) || []).length).toBe(1);
    expect((ics.match(/END:VEVENT/g) || []).length).toBe(1);
    expect(ics).toContain('SUMMARY:Equipe A vs Equipe B');
  });

  it('uses the default 90 minute duration', () => {
    const ics = generateIcal([makeMatch({ date: '20/01/2026', time: '10:00' })], {});
    expect(durationFromIcal(ics)).toBe(90);
  });

  it('uses a configured event duration', () => {
    const ics = generateIcal([makeMatch({ durationMinutes: 180 })], {});
    expect(durationFromIcal(ics)).toBe(180);
  });

  it('filters events by assigned person name for historical data', () => {
    const matchWithArbitre = makeMatch({ id: 'match-1' });
    const matchWithoutArbitre = makeMatch({ id: 'match-2', localTeam: 'Equipe C', awayTeam: 'Equipe D' });
    const allExtras: Record<string, MatchExtras> = {
      'match-1': { id: 'match-1', arbitreTouche: [{ nom: 'Jean Dupont', numero: '' }] },
    };

    const ics = generateIcal([matchWithArbitre, matchWithoutArbitre], allExtras, undefined, {
      personNom: 'Jean Dupont',
      role: 'all',
    });

    expect(ics).toContain('UID:officiel-match-1@club-inconnu.clubika');
    expect(ics).not.toContain('match-2@');
  });

  it('prefers stable person id/type when the display name changes', () => {
    const assigned = makeMatch({ id: 'match-1' });
    const other = makeMatch({ id: 'match-2' });
    const allExtras: Record<string, MatchExtras> = {
      'match-1': {
        id: 'match-1',
        arbitreTouche: [{ nom: 'Nouveau nom', numero: '', personId: 42, personType: 'officiel' }],
      },
      'match-2': {
        id: 'match-2',
        arbitreTouche: [{ nom: 'Ancien nom', numero: '', personId: 99, personType: 'officiel' }],
      },
    };

    const ics = generateIcal([assigned, other], allExtras, undefined, {
      personNom: 'Ancien nom',
      personId: 42,
      personType: 'officiel',
      role: 'arbitre',
    });

    expect(ics).toContain('UID:officiel-match-1@club-inconnu.clubika');
    expect(ics).not.toContain('match-2@');
  });

  it('includes entrainement events with their lieu as LOCATION', () => {
    const entrainement: Entrainement = {
      id: 'ent-1',
      type: 'entrainement',
      date: '20/01/2026',
      time: '18:00',
      lieu: 'Stade Municipal',
    };

    const ics = generateIcal([entrainement], {});
    expect(ics).toContain('LOCATION:Stade Municipal');
  });

  it('skips events with an unparseable date', () => {
    const invalid = makeMatch({ id: 'bad', date: 'not-a-date' });
    const ics = generateIcal([invalid], {});
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('emits cancelled events with STATUS:CANCELLED instead of dropping them (issue #79)', () => {
    const cancelled = makeMatch({ id: 'match-annule' });
    const allExtras: Record<string, MatchExtras> = {
      'match-annule': { id: 'match-annule', planningStatus: 'cancelled' },
    };

    const ics = generateIcal([cancelled], allExtras);

    expect(ics).toContain('UID:officiel-match-annule@club-inconnu.clubika');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:1');
    expect(ics).toContain('SUMMARY:ANNULÉ : Equipe A vs Equipe B');
  });

  it('keeps published events without STATUS:CANCELLED', () => {
    const published = makeMatch({ id: 'match-ok' });
    const allExtras: Record<string, MatchExtras> = {
      'match-ok': { id: 'match-ok', planningStatus: 'published' },
    };

    const ics = generateIcal([published], allExtras);

    expect(ics).toContain('UID:officiel-match-ok@club-inconnu.clubika');
    expect(ics).not.toContain('STATUS:CANCELLED');
    expect(ics).not.toContain('ANNULÉ');
  });

  describe('UID namespacing (issue #278)', () => {
    it('produces different UIDs for two clubs sharing the same local event id', () => {
      const eventA = makeMatch({ id: 'shared-id' });
      const eventB = makeMatch({ id: 'shared-id' });

      const icsClubA = generateIcal([eventA], {}, undefined, { clubId: 'club-a' });
      const icsClubB = generateIcal([eventB], {}, undefined, { clubId: 'club-b' });

      const uidA = icsClubA.match(/UID:([^\r\n]+)/)?.[1];
      const uidB = icsClubB.match(/UID:([^\r\n]+)/)?.[1];

      expect(uidA).toBeTruthy();
      expect(uidB).toBeTruthy();
      expect(uidA).not.toBe(uidB);
      expect(uidA).toBe('officiel-shared-id@club-a.clubika');
      expect(uidB).toBe('officiel-shared-id@club-b.clubika');
    });

    it('produces different UIDs for two event types sharing the same local id and club', () => {
      const match = makeMatch({ id: 'shared-id', type: 'officiel' });
      const entrainement: Entrainement = {
        id: 'shared-id',
        type: 'entrainement',
        date: '20/01/2026',
        time: '18:00',
        lieu: 'Stade Municipal',
      };

      const ics = generateIcal([match, entrainement], {}, undefined, { clubId: 'club-a' });
      const uids = [...ics.matchAll(/UID:([^\r\n]+)/g)].map((m) => m[1]);

      expect(uids).toHaveLength(2);
      expect(uids[0]).not.toBe(uids[1]);
      expect(uids).toContain('officiel-shared-id@club-a.clubika');
      expect(uids).toContain('entrainement-shared-id@club-a.clubika');
    });

    it('keeps the UID stable when other editable fields of the event change', () => {
      const before = makeMatch({ id: 'match-1', localTeam: 'Equipe A', awayTeam: 'Equipe B' });
      const after = makeMatch({
        id: 'match-1',
        localTeam: 'Equipe Renommée',
        awayTeam: 'Autre Adversaire',
        date: '21/02/2026',
        time: '15:00',
        competition: 'Coupe',
      });

      const options = { clubId: 'club-a' };
      const icsBefore = generateIcal([before], {}, undefined, options);
      const icsAfter = generateIcal([after], {}, undefined, options);

      const uidBefore = icsBefore.match(/UID:([^\r\n]+)/)?.[1];
      const uidAfter = icsAfter.match(/UID:([^\r\n]+)/)?.[1];

      expect(uidBefore).toBe(uidAfter);
      expect(uidBefore).toBe('officiel-match-1@club-a.clubika');
    });

    it('does not fall back to the legacy pre-#278 UID format, acknowledging the breaking change for existing subscribers', () => {
      const match = makeMatch({ id: 'match-1' });
      const ics = generateIcal([match], {}, undefined, { clubId: 'club-a' });

      // Ancien format (avant #278) : `${event.id}@clubika`, sans namespace de type ni de
      // club. On vérifie explicitement qu'il n'est plus émis : le garder en parallèle
      // reproduirait la collision qu'on corrige (voir le commentaire au-dessus de
      // `buildEventUid` dans ical-export.ts pour la discussion complète du compromis).
      expect(ics).not.toContain('UID:match-1@clubika');
      expect(ics).toContain('UID:officiel-match-1@club-a.clubika');
    });

    it('falls back to a safe namespace segment when no clubId is provided', () => {
      const match = makeMatch({ id: 'match-1' });
      const ics = generateIcal([match], {});

      expect(ics).toContain('UID:officiel-match-1@club-inconnu.clubika');
    });

    it('sanitizes clubId and event id into RFC 5545-safe UID characters', () => {
      const match = makeMatch({ id: 'match id/with spaces' });
      const ics = generateIcal([match], {}, undefined, { clubId: 'club é&space' });

      const uid = ics.match(/UID:([^\r\n]+)/)?.[1];
      expect(uid).toBeTruthy();
      expect(uid).toMatch(/^officiel-match-id-with-spaces@club---space\.clubika$/);
    });
  });
});
