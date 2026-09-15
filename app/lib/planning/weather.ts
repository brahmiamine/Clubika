import type { DataSource } from 'typeorm';
import { getPlanningEventSnapshot, type PlanningEventSnapshot, type PlanningEventType } from './event-store';
import { eventStartTimestamp } from './p0-rules';
import { readAppSettings } from '@/lib/settings-store';
import { getCurrentClubId } from '@/lib/auth/club-context';
import type { EventWeatherDisplay } from './weather-condition';
import {
  configuredServiceBaseUrl,
  guardedFetch,
  isExternalServiceEnabled,
} from '@/lib/compliance/external-services';

/** Paris — 48°51'03.4"N 2°20'59.5"E. Toutes les prévisions Open-Meteo partent de ce point. */
export const PARIS_WEATHER_COORDINATES = {
  lat: 48 + 51 / 60 + 3.4 / 3600,
  lon: 2 + 20 / 60 + 59.5 / 3600,
} as const;

export type WeatherSeverity = 'normal' | 'warning' | 'severe';

export type PlanningWeatherResult =
  | { available: false; reason: string }
  | {
      available: true;
      severity: WeatherSeverity;
      weatherCode: number;
      isDay: boolean | null;
      temperatureC: number | null;
      precipitationProbability: number | null;
      windGustKmh: number | null;
      alerts: string[];
      coordinates?: { lat: number; lon: number };
      locationSource?: string;
    };

interface OpenMeteoPayload {
  hourly?: {
    time?: unknown;
    weather_code?: unknown;
    temperature_2m?: unknown;
    is_day?: unknown;
    precipitation_probability?: unknown;
    wind_gusts_10m?: unknown;
  };
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Cache applicatif court, partagé entre tous les utilisateurs consultant le même
// événement (issue #222) : le serveur Node est long-lived (server.ts), une Map en mémoire
// suffit donc à réduire les appels redondants à l'API gratuite Open-Meteo sans base de
// données ni infrastructure supplémentaire. N'entrepose jamais un échec : une panne ou un
// rate-limit ne doit jamais empêcher la tentative suivante de réessayer immédiatement.
const GEOCODE_CACHE_TTL_MS = 30 * 60 * 1000;
const FORECAST_CACHE_TTL_MS = 5 * 60 * 1000;
const geocodeCache = new Map<string, CacheEntry<{ lat: number; lon: number } | null>>();
const forecastCache = new Map<string, CacheEntry<unknown>>();

function fromCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function toCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function numericAt(value: unknown, index: number): number | null {
  if (!Array.isArray(value)) return null;
  const item = Number(value[index]);
  return Number.isFinite(item) ? item : null;
}

/** Série horaire alignée sur `time` : longueur différente → ignorée, jamais de lecture décalée. */
function alignedNumericAt(value: unknown, index: number, expectedLength: number): number | null {
  if (!Array.isArray(value) || value.length !== expectedLength) return null;
  return numericAt(value, index);
}

function alignedIsDay(value: unknown, index: number, expectedLength: number): boolean | null {
  const flag = alignedNumericAt(value, index, expectedLength);
  if (flag === 1) return true;
  if (flag === 0) return false;
  return null;
}

export function parseOpenMeteoForecast(payload: unknown, targetIsoHour: string): PlanningWeatherResult {
  if (!payload || typeof payload !== 'object') return { available: false, reason: 'forecast-unavailable' };
  const hourly = (payload as OpenMeteoPayload).hourly;
  if (!hourly || !Array.isArray(hourly.time) || hourly.time.length === 0) {
    return { available: false, reason: 'forecast-unavailable' };
  }
  if (!Array.isArray(hourly.weather_code) || hourly.weather_code.length !== hourly.time.length) {
    return { available: false, reason: 'forecast-unavailable' };
  }

  const normalizedTarget = /(?:Z|[+-]\d{2}:?\d{2})$/.test(targetIsoHour)
    ? targetIsoHour
    : `${targetIsoHour}${targetIsoHour.length === 16 ? ':00' : ''}Z`;
  const target = Date.parse(normalizedTarget);
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  hourly.time.forEach((raw, index) => {
    if (typeof raw !== 'string') return;
    const stamp = Date.parse(`${raw}:00Z`);
    if (!Number.isFinite(stamp)) return;
    const distance = Math.abs(stamp - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  if (bestIndex < 0) return { available: false, reason: 'forecast-unavailable' };

  const seriesLength = hourly.time.length;
  const weatherCode = alignedNumericAt(hourly.weather_code, bestIndex, seriesLength);
  if (weatherCode === null) return { available: false, reason: 'forecast-unavailable' };
  const temperatureC = alignedNumericAt(hourly.temperature_2m, bestIndex, seriesLength);
  const precipitationProbability = alignedNumericAt(hourly.precipitation_probability, bestIndex, seriesLength);
  const windGustKmh = alignedNumericAt(hourly.wind_gusts_10m, bestIndex, seriesLength);
  const isDay = alignedIsDay(hourly.is_day, bestIndex, seriesLength);
  const alerts: string[] = [];
  let severity: WeatherSeverity = 'normal';

  if ([95, 96, 99].includes(weatherCode)) {
    alerts.push('Risque d’orage');
    severity = 'severe';
  } else if ([80, 81, 82, 85, 86].includes(weatherCode)) {
    alerts.push('Averses prévues');
    severity = 'warning';
  }
  if (windGustKmh !== null && windGustKmh >= 70) {
    alerts.push(`Rafales fortes (${Math.round(windGustKmh)} km/h)`);
    severity = 'severe';
  } else if (windGustKmh !== null && windGustKmh >= 50 && severity === 'normal') {
    alerts.push(`Rafales (${Math.round(windGustKmh)} km/h)`);
    severity = 'warning';
  }
  if (precipitationProbability !== null && precipitationProbability >= 80) {
    alerts.push(`Forte probabilité de pluie (${Math.round(precipitationProbability)} %)`);
    if (severity === 'normal') severity = 'warning';
  }
  if (temperatureC !== null && temperatureC >= 35) {
    alerts.push(`Forte chaleur (${Math.round(temperatureC)} °C)`);
    if (severity === 'normal') severity = 'warning';
  }
  if (temperatureC !== null && temperatureC <= 0) {
    alerts.push(`Risque de gel (${Math.round(temperatureC)} °C)`);
    if (severity === 'normal') severity = 'warning';
  }

  return {
    available: true,
    severity,
    weatherCode,
    isDay,
    temperatureC,
    precipitationProbability,
    windGustKmh,
    alerts,
  };
}

/**
 * Extrait un nom de commune géocodable depuis une adresse postale française
 * (« 2 Rue Jean Cocteau, 75018 Paris » → « Paris »). L'API de géocodage Open-Meteo
 * ne résout pas les adresses complètes ni les noms de stades, mais très bien les villes.
 */
export function cityFromAddress(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  // Motif le plus fiable : code postal (4-5 chiffres) suivi de la commune, en fin de chaîne.
  const postalMatch = trimmed.match(/\b\d{4,5}\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ -]+?)\s*(?:,\s*[A-Za-zÀ-ÿ'’ -]+)?$/);
  if (postalMatch?.[1]) return postalMatch[1].trim();
  // Sinon, le dernier segment séparé par une virgule, débarrassé d'un éventuel code postal.
  const segments = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
  const last = segments[segments.length - 1]?.replace(/\d{4,5}/g, '').trim();
  return last && /[A-Za-zÀ-ÿ]/.test(last) ? last : null;
}

/** Lieux successifs à tenter pour géocoder un événement, du plus précis au plus large. */
export function weatherGeocodeCandidates(snapshot: Pick<PlanningEventSnapshot, 'location' | 'event'>): string[] {
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !candidates.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      candidates.push(trimmed);
    }
  };
  push(snapshot.location);
  const details = 'details' in snapshot.event ? snapshot.event.details ?? null : null;
  push(details?.stadium);
  push(details?.address);
  if (details?.address) push(cityFromAddress(details.address));
  return candidates;
}

export async function geocodeLocation(location: string): Promise<{ lat: number; lon: number } | null> {
  const cacheKey = location.trim().toLowerCase();
  const cached = fromCache(geocodeCache, cacheKey);
  if (cached !== undefined) return cached;

  const base = configuredServiceBaseUrl('open-meteo-geocoding');
  if (!isExternalServiceEnabled('open-meteo') || !base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set('name', location);
    url.searchParams.set('count', '1');
    url.searchParams.set('language', 'fr');
    url.searchParams.set('format', 'json');
    const response = await guardedFetch('open-meteo', url.toString(), { signal: AbortSignal.timeout(3500), cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json() as { results?: Array<{ latitude?: number; longitude?: number }> };
    const first = data.results?.[0];
    const result = first && Number.isFinite(first.latitude) && Number.isFinite(first.longitude)
      ? { lat: Number(first.latitude), lon: Number(first.longitude) }
      : null;
    toCache(geocodeCache, cacheKey, result, GEOCODE_CACHE_TTL_MS);
    return result;
  } catch {
    return null;
  }
}

export function toPublicEventWeather(result: PlanningWeatherResult): EventWeatherDisplay | null {
  if (!result.available) return null;
  return {
    weatherCode: result.weatherCode,
    temperatureC: result.temperatureC,
    isDay: result.isDay,
  };
}

export async function getPlanningWeather(
  db: DataSource,
  eventType: PlanningEventType,
  eventId: string,
): Promise<PlanningWeatherResult> {
  const snapshot = await getPlanningEventSnapshot(db, eventType, eventId);
  if (!snapshot) return { available: false, reason: 'event-not-found' };
  const { timeZone } = await readAppSettings(db, getCurrentClubId());
  const start = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
  if (start === null) return { available: false, reason: 'event-date-invalid' };

  const coordinates = { lat: PARIS_WEATHER_COORDINATES.lat, lon: PARIS_WEATHER_COORDINATES.lon };
  const locationSource = 'Paris';

  const target = new Date(start);
  const date = target.toISOString().slice(0, 10);
  const targetHour = `${target.toISOString().slice(0, 13)}:00:00Z`;
  const base = configuredServiceBaseUrl('open-meteo-forecast');
  if (!isExternalServiceEnabled('open-meteo') || !base) {
    return { available: false, reason: 'provider-disabled' };
  }
  // Clé par lieu (arrondi à ~100 m, largement suffisant pour une prévision horaire) et par
  // jour : la charge utile brute est mise en cache, puis reparsée pour l'heure exacte de
  // chaque événement — plusieurs événements le même jour au même endroit ne déclenchent
  // qu'un seul appel externe (issue #222).
  const forecastCacheKey = `${coordinates.lat.toFixed(3)}:${coordinates.lon.toFixed(3)}:${date}`;
  try {
    let payload = fromCache(forecastCache, forecastCacheKey);
    if (payload === undefined) {
      const url = new URL(base);
      url.searchParams.set('latitude', String(coordinates.lat));
      url.searchParams.set('longitude', String(coordinates.lon));
      url.searchParams.set(
        'hourly',
        'temperature_2m,weather_code,is_day,precipitation_probability,wind_gusts_10m',
      );
      url.searchParams.set('timezone', 'UTC');
      url.searchParams.set('start_date', date);
      url.searchParams.set('end_date', date);
      const response = await guardedFetch('open-meteo', url.toString(), { signal: AbortSignal.timeout(4000), cache: 'no-store' });
      if (!response.ok) return { available: false, reason: 'provider-unavailable' };
      payload = await response.json();
      toCache(forecastCache, forecastCacheKey, payload, FORECAST_CACHE_TTL_MS);
    }
    const parsed = parseOpenMeteoForecast(payload, targetHour);
    return parsed.available ? { ...parsed, coordinates, locationSource: locationSource ?? undefined } : parsed;
  } catch {
    return { available: false, reason: 'provider-unavailable' };
  }
}
