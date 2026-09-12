import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@/lib/settings';
import { isWithinCurrentWeekend } from './planning-time';
import { filterOfficialEventsForDisplay, filterOfficialMatchesForDisplay } from './official-match-visibility';

const PARIS = 'Europe/Paris';
/** Jeudi 20/08/2026 10:00 UTC → week-end club = samedi 22 et dimanche 23 août. */
const THURSDAY = Date.UTC(2026, 7, 20, 10, 0, 0);

describe('isWithinCurrentWeekend', () => {
  it('inclut le samedi et le dimanche du week-end visé', () => {
    expect(isWithinCurrentWeekend('22/08/2026', '15:00', PARIS, THURSDAY)).toBe(true);
    expect(isWithinCurrentWeekend('23/08/2026', '09:00', PARIS, THURSDAY)).toBe(true);
  });

  it('exclut le vendredi précédent et le lundi suivant', () => {
    expect(isWithinCurrentWeekend('21/08/2026', '20:00', PARIS, THURSDAY)).toBe(false);
    expect(isWithinCurrentWeekend('24/08/2026', '10:00', PARIS, THURSDAY)).toBe(false);
  });
});

describe('filterOfficialMatchesForDisplay', () => {
  const weekendMatch = { id: 'sat', date: '22/08/2026', time: '15:00' };
  const laterMatch = { id: 'later', date: '20/10/2026', time: '15:00' };

  it('ne garde que le week-end en cours quand le paramètre est actif', () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      timeZone: PARIS,
      features: { ...DEFAULT_APP_SETTINGS.features, officialMatchesCurrentWeekendOnly: true },
    };
    expect(filterOfficialMatchesForDisplay([weekendMatch, laterMatch], settings, THURSDAY).map((item) => item.id))
      .toEqual(['sat']);
  });

  it('laisse tous les matchs quand le paramètre est désactivé', () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      timeZone: PARIS,
      features: { ...DEFAULT_APP_SETTINGS.features, officialMatchesCurrentWeekendOnly: false },
    };
    expect(filterOfficialMatchesForDisplay([weekendMatch, laterMatch], settings, THURSDAY)).toHaveLength(2);
  });
});

describe('filterOfficialEventsForDisplay', () => {
  it('filtre uniquement les matchs officiels, pas les amicaux ni entraînements', () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      timeZone: PARIS,
      features: { ...DEFAULT_APP_SETTINGS.features, officialMatchesCurrentWeekendOnly: true },
    };
    const events = [
      { eventType: 'officiel' as const, date: '22/08/2026', time: '15:00', id: 'off-weekend' },
      { eventType: 'officiel' as const, date: '20/10/2026', time: '15:00', id: 'off-later' },
      { eventType: 'amical' as const, date: '20/10/2026', time: '15:00', id: 'amical' },
      { eventType: 'entrainement' as const, date: '21/08/2026', time: '18:00', id: 'train' },
    ];
    expect(filterOfficialEventsForDisplay(events, settings, THURSDAY).map((item) => item.id))
      .toEqual(['off-weekend', 'amical', 'train']);
  });
});
