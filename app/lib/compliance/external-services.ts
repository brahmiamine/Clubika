/**
 * Registre exécutable des flux sortants (issue #30).
 *
 * En production, aucun appel réseau n’est autorisé tant que le service n’est pas
 * explicitement activé **et** que l’hôte est allowlisté. Les URL publiques de
 * démonstration (OSRM, Open-Meteo, proxy de logos ouvert) ne sont jamais des
 * valeurs par défaut de production.
 *
 * SportCorico et WhatsApp restent gouvernés par #4/#5 et #17 ; cette barrière
 * commune ne présume pas leur autorisation juridique.
 */

export type ExternalServiceId =
  | 'smtp'
  | 'whatsapp'
  | 'web-push'
  | 'open-meteo'
  | 'routing'
  | 'logo-proxy'
  | 'sportcorico';

export type ExternalServiceEnvironment = Readonly<Record<string, string | undefined>>;

export interface ExternalServiceDefinition {
  id: ExternalServiceId;
  label: string;
  /** Variable d’environnement qui doit valoir exactement `true`, sauf WhatsApp (`WHATSAPP_PROVIDER`). */
  enabledEnv: string;
  purpose: string;
  dataCategories: string[];
  /** Statut factuel : aucune conclusion juridique n’est inventée ici. */
  legalReview: 'required';
}

export interface ExternalServiceStatus extends ExternalServiceDefinition {
  enabled: boolean;
  hostnames: string[];
}

export class ExternalServiceBlockedError extends Error {
  readonly serviceId: ExternalServiceId;

  constructor(serviceId: ExternalServiceId, message: string) {
    super(message);
    this.name = 'ExternalServiceBlockedError';
    this.serviceId = serviceId;
  }
}

export const EXTERNAL_SERVICE_REGISTRY: Record<ExternalServiceId, ExternalServiceDefinition> = {
  smtp: {
    id: 'smtp',
    label: 'SMTP (e-mail)',
    enabledEnv: 'SMTP_ENABLED',
    purpose: 'Notifications e-mail et envoi du lien de réinitialisation du mot de passe au titulaire du compte.',
    dataCategories: ['contact.email', 'notification.subject', 'notification.text'],
    legalReview: 'required',
  },
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    enabledEnv: 'WHATSAPP_PROVIDER',
    purpose: 'Notifications WhatsApp vers un numéro de profil, via Meta Cloud API ou un webhook déclaré.',
    dataCategories: ['contact.phone', 'notification.text'],
    legalReview: 'required',
  },
  'web-push': {
    id: 'web-push',
    label: 'Web Push',
    enabledEnv: 'WEB_PUSH_ENABLED',
    purpose: 'Notifications push PWA vers les endpoints d’abonnement du navigateur.',
    dataCategories: ['notification.title', 'notification.message', 'planning.eventId'],
    legalReview: 'required',
  },
  'open-meteo': {
    id: 'open-meteo',
    label: 'Météo (Open-Meteo)',
    enabledEnv: 'OPEN_METEO_ENABLED',
    purpose: 'Prévision horaire pour un événement (coordonnées, pas d’identité).',
    dataCategories: ['location.coordinates'],
    legalReview: 'required',
  },
  routing: {
    id: 'routing',
    label: 'Routage (OSRM-compatible)',
    enabledEnv: 'ROUTING_ENABLED',
    purpose: 'Estimation de trajet entre deux points (lat/lon uniquement).',
    dataCategories: ['location.coordinates'],
    legalReview: 'required',
  },
  'logo-proxy': {
    id: 'logo-proxy',
    label: 'Proxy de logos distants',
    enabledEnv: 'LOGO_PROXY_ENABLED',
    purpose: 'Récupération d’images de blasons pour le partage et l’export PDF.',
    dataCategories: ['image.bytes'],
    legalReview: 'required',
  },
  sportcorico: {
    id: 'sportcorico',
    label: 'SportCorico',
    enabledEnv: 'SPORTCORICO_SYNC_ENABLED',
    purpose: 'Import des matchs officiels. Activation réelle traitée par #4/#5.',
    dataCategories: ['planning.official-match'],
    legalReview: 'required',
  },
};

export const EXTERNAL_SERVICE_IDS = Object.keys(EXTERNAL_SERVICE_REGISTRY) as ExternalServiceId[];

const WEB_PUSH_HOST_PATTERNS = [
  'fcm.googleapis.com',
  '*.push.services.mozilla.com',
  '*.push.apple.com',
] as const;

export function isProductionEnv(env: ExternalServiceEnvironment = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function envFlagEnabled(name: string, env: ExternalServiceEnvironment = process.env): boolean {
  return env[name]?.trim() === 'true';
}

export function isExternalServiceEnabled(
  id: ExternalServiceId,
  env: ExternalServiceEnvironment = process.env,
): boolean {
  if (id === 'whatsapp') {
    const provider = env.WHATSAPP_PROVIDER?.trim().toLowerCase();
    return provider === 'meta' || provider === 'webhook';
  }
  return envFlagEnabled(EXTERNAL_SERVICE_REGISTRY[id].enabledEnv, env);
}

function parseHostList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameFromUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function hostnameAllowed(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    if (normalized.startsWith('*.')) {
      const suffix = normalized.slice(1);
      return host.endsWith(suffix) && host !== normalized.slice(2);
    }
    return host === normalized;
  });
}

export function allowedHostnamesFor(
  id: ExternalServiceId,
  env: ExternalServiceEnvironment = process.env,
): string[] {
  switch (id) {
    case 'smtp': {
      const hosts = parseHostList(env.SMTP_ALLOWED_HOSTS);
      const configured = env.SMTP_HOST?.trim().toLowerCase();
      if (configured) hosts.push(configured);
      return [...new Set(hosts)];
    }
    case 'whatsapp': {
      const hosts = ['graph.facebook.com'];
      const webhookHost = hostnameFromUrl(env.NOTIFICATION_WHATSAPP_WEBHOOK_URL);
      if (webhookHost) hosts.push(webhookHost);
      return hosts;
    }
    case 'web-push':
      return [...WEB_PUSH_HOST_PATTERNS];
    case 'open-meteo': {
      const hosts = [
        hostnameFromUrl(env.OPEN_METEO_FORECAST_URL),
        hostnameFromUrl(env.OPEN_METEO_GEOCODING_URL),
      ].filter((host): host is string => Boolean(host));
      return [...new Set(hosts)];
    }
    case 'routing': {
      const host = hostnameFromUrl(env.ROUTING_API_BASE_URL);
      return host ? [host] : [];
    }
    case 'logo-proxy':
      return parseHostList(env.LOGO_PROXY_ALLOWED_HOSTS);
    case 'sportcorico':
      return ['api.sportcorico.com', 'www.sportcorico.com'];
    default:
      return [];
  }
}

export function isSmtpHostAllowed(host: string, env: ExternalServiceEnvironment = process.env): boolean {
  if (!isExternalServiceEnabled('smtp', env)) return false;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return false;
  const restricted = parseHostList(env.SMTP_ALLOWED_HOSTS);
  if (restricted.length > 0) return hostnameAllowed(trimmed, restricted);
  return true;
}

export function assertExternalUrlAllowed(
  id: ExternalServiceId,
  rawUrl: string,
  env: ExternalServiceEnvironment = process.env,
): URL {
  if (!isExternalServiceEnabled(id, env)) {
    throw new ExternalServiceBlockedError(id, `Intégration ${id} désactivée`);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ExternalServiceBlockedError(id, `URL ${id} invalide`);
  }
  if (url.protocol !== 'https:') {
    if (isProductionEnv(env) || id !== 'logo-proxy' || url.protocol !== 'http:') {
      throw new ExternalServiceBlockedError(id, `HTTPS requis pour ${id}`);
    }
  }
  const allowed = allowedHostnamesFor(id, env);
  if (allowed.length === 0 || !hostnameAllowed(url.hostname, allowed)) {
    throw new ExternalServiceBlockedError(id, `Hôte non allowlisté pour ${id}`);
  }
  return url;
}

export async function guardedFetch(
  id: ExternalServiceId,
  rawUrl: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
  env: ExternalServiceEnvironment = process.env,
): Promise<Response> {
  const url = assertExternalUrlAllowed(id, rawUrl, env);
  return fetchImpl(url.href, init);
}

export function listExternalServiceStatuses(
  env: ExternalServiceEnvironment = process.env,
): ExternalServiceStatus[] {
  return EXTERNAL_SERVICE_IDS.map((id) => ({
    ...EXTERNAL_SERVICE_REGISTRY[id],
    enabled: isExternalServiceEnabled(id, env),
    hostnames: allowedHostnamesFor(id, env),
  }));
}

export function configuredServiceBaseUrl(
  id: 'open-meteo-forecast' | 'open-meteo-geocoding' | 'routing',
  env: ExternalServiceEnvironment = process.env,
): string | null {
  const raw = id === 'routing'
    ? env.ROUTING_API_BASE_URL
    : id === 'open-meteo-forecast'
      ? env.OPEN_METEO_FORECAST_URL
      : env.OPEN_METEO_GEOCODING_URL;
  const trimmed = raw?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : null;
}
