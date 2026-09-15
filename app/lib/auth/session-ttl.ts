export type SessionAudience = 'club' | 'club-admin' | 'platform';

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sessionTtlSeconds(audience: SessionAudience): { idle: number; absolute: number } {
  if (audience === 'platform') {
    return {
      idle: envPositiveNumber('PLATFORM_SESSION_IDLE_TTL_HOURS', 4) * 60 * 60,
      absolute: envPositiveNumber('PLATFORM_SESSION_ABSOLUTE_TTL_HOURS', 12) * 60 * 60,
    };
  }
  if (audience === 'club-admin') {
    return {
      idle: envPositiveNumber('SESSION_ADMIN_IDLE_TTL_HOURS', 12) * 60 * 60,
      absolute: envPositiveNumber('SESSION_ADMIN_ABSOLUTE_TTL_DAYS', 7) * 24 * 60 * 60,
    };
  }
  return {
    idle: envPositiveNumber('SESSION_IDLE_TTL_HOURS', 168) * 60 * 60,
    absolute: envPositiveNumber('SESSION_TTL_DAYS', 30) * 24 * 60 * 60,
  };
}

export function sessionAudienceForAccessRole(accessRole: string | null | undefined): SessionAudience {
  return accessRole === 'admin' ? 'club-admin' : 'club';
}
