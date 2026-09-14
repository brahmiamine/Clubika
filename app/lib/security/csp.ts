import { randomBytes } from 'node:crypto';

const CSP_REPORT_PATH = '/api/security/csp-report';

/**
 * CSP report-only (issue #35) : enforcement après observation. Pas de 'unsafe-inline'
 * arbitraire. Rollback = retirer l’en-tête Content-Security-Policy-Report-Only dans
 * proxy.ts (et HSTS dans deploy/Caddyfile). Rétention des rapports : 7 jours.
 */
export function buildCspReportOnly(nonce: string): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
    `report-uri ${CSP_REPORT_PATH}`,
  ];
  return directives.join('; ');
}

export function newCspNonce(): string {
  return randomBytes(16).toString('base64url');
}

const HOST_LIKE = /^[A-Za-z0-9._:-]{1,253}$/;
const DIRECTIVE_LIKE = /^[a-z0-9-]+(?:\s+'[a-z0-9-]+')?$/i;

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === 'inline' || trimmed === 'eval' || trimmed === 'data' || trimmed === 'blob') {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const host = url.host || url.protocol.replace(/:$/, '');
    return HOST_LIKE.test(host) ? host : null;
  } catch {
    return null;
  }
}

export interface SanitizedCspReport {
  documentHost: string;
  blockedHost: string | null;
  violatedDirective: string;
  disposition: 'report' | 'enforce';
}

/**
 * Ne conserve que des hôtes et une directive. Jamais d'URI complète, cookie,
 * jeton ou donnée personnelle (issue #35).
 */
export function sanitizeCspReport(body: unknown): SanitizedCspReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const report = (record['csp-report'] && typeof record['csp-report'] === 'object'
    ? record['csp-report']
    : record) as Record<string, unknown>;

  const documentHost = hostOf(report['document-uri'] ?? report.documentURI);
  if (!documentHost) return null;

  const violated = String(report['violated-directive'] ?? report.effectiveDirective ?? report['effective-directive'] ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 64);
  if (!violated || !DIRECTIVE_LIKE.test(violated.split(' ')[0] ?? '')) return null;

  const disposition = report.disposition === 'enforce' ? 'enforce' : 'report';
  return {
    documentHost,
    blockedHost: hostOf(report['blocked-uri'] ?? report.blockedURL),
    violatedDirective: violated.split(' ')[0]!,
    disposition,
  };
}
