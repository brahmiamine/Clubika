import { describe, expect, it, vi } from 'vitest';
import { cityFromAddress, geocodeLocation, parseOpenMeteoForecast, PARIS_WEATHER_COORDINATES, toPublicEventWeather, weatherGeocodeCandidates } from './weather';

describe('Paris weather coordinates', () => {
  it('fixe le point 48°51′03.4″N 2°20′59.5″E', () => {
    expect(PARIS_WEATHER_COORDINATES.lat).toBeCloseTo(48.850944, 5);
    expect(PARIS_WEATHER_COORDINATES.lon).toBeCloseTo(2.349861, 5);
  });
});

describe('weather location fallback', () => {
  it('extrait la commune d’une adresse postale française', () => {
    expect(cityFromAddress('2 Rue Jean Cocteau, 75018 Paris')).toBe('Paris');
    expect(cityFromAddress('Stade des Poissonniers, 75018 Paris 18e')).toBe('Paris 18e');
    expect(cityFromAddress('12 av. du Général Leclerc, 92100 Boulogne-Billancourt')).toBe('Boulogne-Billancourt');
  });

  it('propose des lieux du plus précis au plus large, ville comprise', () => {
    const candidates = weatherGeocodeCandidates({
      location: 'Stade des Poissonniers',
      event: { details: { stadium: 'Stade des Poissonniers', address: '2 Rue Jean Cocteau, 75018 Paris' } },
    } as Parameters<typeof weatherGeocodeCandidates>[0]);
    expect(candidates).toEqual([
      'Stade des Poissonniers',
      '2 Rue Jean Cocteau, 75018 Paris',
      'Paris',
    ]);
  });
});

describe('planning weather', () => {
  it('returns a severe alert for thunderstorms and strong gusts near event time', () => {
    const result = parseOpenMeteoForecast({
      hourly: {
        time: ['2026-08-23T14:00', '2026-08-23T15:00'],
        weather_code: [3, 95],
        temperature_2m: [28, 27],
        is_day: [1, 1],
        precipitation_probability: [20, 90],
        wind_gusts_10m: [25, 75],
      },
    }, '2026-08-23T15:00');

    expect(result).toEqual(expect.objectContaining({
      available: true,
      severity: 'severe',
      weatherCode: 95,
      isDay: true,
      precipitationProbability: 90,
      windGustKmh: 75,
    }));
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('Expected an available weather forecast');
    expect(result.alerts.length).toBeGreaterThan(0);
  });

  it('degrades to unavailable for malformed provider data', () => {
    expect(parseOpenMeteoForecast({}, '2026-08-23T15:00')).toEqual({ available: false, reason: 'forecast-unavailable' });
  });

  it('expose le code, la température et le jour/nuit sur le lien public', () => {
    expect(toPublicEventWeather({ available: false, reason: 'forecast-unavailable' })).toBeNull();
    expect(toPublicEventWeather({
      available: true,
      severity: 'normal',
      weatherCode: 2,
      isDay: false,
      temperatureC: 25,
      precipitationProbability: 10,
      windGustKmh: 12,
      alerts: [],
    })).toEqual({ weatherCode: 2, temperatureC: 25, isDay: false });
  });

  it('lit is_day à la même heure que weather_code', () => {
    const result = parseOpenMeteoForecast({
      hourly: {
        time: ['2026-08-23T20:00', '2026-08-23T21:00'],
        weather_code: [0, 0],
        temperature_2m: [18, 16],
        is_day: [1, 0],
      },
    }, '2026-08-23T21:00');
    expect(result).toEqual(expect.objectContaining({ available: true, weatherCode: 0, isDay: false }));
  });

  it('ignore une série horaire désynchronisée plutôt que de lire un index décalé', () => {
    const result = parseOpenMeteoForecast({
      hourly: {
        time: ['2026-08-23T14:00', '2026-08-23T15:00'],
        weather_code: [3, 3],
        temperature_2m: [20],
        is_day: [1],
        precipitation_probability: [10, 20],
      },
    }, '2026-08-23T15:00');
    expect(result).toEqual(expect.objectContaining({
      available: true,
      weatherCode: 3,
      temperatureC: null,
      isDay: null,
      precipitationProbability: 20,
    }));
  });

  it('refuse une prévision dont weather_code n’a pas la même longueur que time', () => {
    expect(parseOpenMeteoForecast({
      hourly: {
        time: ['2026-08-23T14:00', '2026-08-23T15:00'],
        weather_code: [3],
        temperature_2m: [20, 21],
      },
    }, '2026-08-23T15:00')).toEqual({ available: false, reason: 'forecast-unavailable' });
  });
});

describe('geocodeLocation — cache applicatif court (issue #222)', () => {
  it('ne rappelle pas le fournisseur de géocodage pour un même lieu dans la fenêtre de cache', async () => {
    vi.stubEnv('OPEN_METEO_ENABLED', 'true');
    vi.stubEnv('OPEN_METEO_GEOCODING_URL', 'https://geocoding.example.test/v1/search');
    const location = `Stade de test ${Math.random()}`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ latitude: 48.85, longitude: 2.35 }] }),
    } as Response);

    try {
      const first = await geocodeLocation(location);
      const second = await geocodeLocation(location);

      expect(first).toEqual({ lat: 48.85, lon: 2.35 });
      expect(second).toEqual({ lat: 48.85, lon: 2.35 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('interroge de nouveau le fournisseur pour un lieu différent', async () => {
    vi.stubEnv('OPEN_METEO_ENABLED', 'true');
    vi.stubEnv('OPEN_METEO_GEOCODING_URL', 'https://geocoding.example.test/v1/search');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ latitude: 43.6, longitude: 1.44 }] }),
    } as Response);

    try {
      await geocodeLocation(`Lieu A ${Math.random()}`);
      await geocodeLocation(`Lieu B ${Math.random()}`);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
