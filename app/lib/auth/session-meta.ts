import { isIP } from 'node:net';
import { hashSessionToken } from './session-token';

/**
 * Famille de navigateur uniquement — jamais le user-agent brut (issue #29).
 */
export function coarseClientHint(userAgent: string | null | undefined): string | null {
  if (!userAgent?.trim()) return null;
  const ua = userAgent.toLowerCase();
  if (ua.includes('edg/') || ua.includes('edg ')) return 'Edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
  if (ua.includes('chrome/') && !ua.includes('edg/')) return 'Chrome';
  if (ua.includes('firefox/')) return 'Firefox';
  if (ua.includes('safari/') && !ua.includes('chrome/')) return 'Safari';
  return 'Autre';
}

function truncateIp(ip: string): string | null {
  const trimmed = ip.trim();
  if (!trimmed || trimmed === 'unknown' || !isIP(trimmed)) return null;
  if (trimmed.includes('.')) {
    const parts = trimmed.split('.');
    if (parts.length !== 4) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  const groups = trimmed.split(':').filter((group) => group.length > 0);
  if (groups.length === 0) return null;
  return `${groups.slice(0, 3).join(':')}::/48`;
}

/**
 * Empreinte HMAC tronquée du préfixe réseau (/24 ou /48). Non exposée à l'API :
 * durée de vie = celle de la ligne de session, accès = administrateurs base uniquement.
 */
export function networkHint(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const truncated = truncateIp(ip);
  if (!truncated) return null;
  return hashSessionToken(truncated).replace(/^v1:/, '').slice(0, 12);
}

export function dayStamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}
