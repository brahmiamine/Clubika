const SENSITIVE_KEY =
  /^(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|pass|api[_-]?key|email|mail|fromemail|from_email|phone|telephone|tel|ip|clientip|forwarded-for|x-forwarded-for|endpoint|payload|body|query|smtpuser|smtp_user|user)$/i;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BEARER_RE = /^(Bearer|Basic)\s+/i;
const PHONE_RE = /\+?\d[\d\s.-]{7,}\d/;

export const REDACTED = '[Redacted]';

export type ProviderErrorCode =
  | 'smtp_failed'
  | 'push_failed'
  | 'whatsapp_failed'
  | 'timeout'
  | 'network_failed'
  | 'unknown';

export function classifyProviderError(error: unknown): { code: ProviderErrorCode; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || /timeout|timed out|délai/i.test(message)) {
    return { code: 'timeout', retryable: true };
  }
  if (/smtp|econnrefused|eauth|invalid login/i.test(message)) {
    return { code: 'smtp_failed', retryable: true };
  }
  if (/web.?push|vapid|gcm|fcm/i.test(message)) {
    return { code: 'push_failed', retryable: true };
  }
  if (/whatsapp|meta graph/i.test(message)) {
    return { code: 'whatsapp_failed', retryable: true };
  }
  if (/fetch|network|econnreset|enotfound/i.test(message) || name === 'TypeError') {
    return { code: 'network_failed', retryable: true };
  }
  return { code: 'unknown', retryable: false };
}

function redactString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (JWT_RE.test(trimmed) || BEARER_RE.test(trimmed)) return REDACTED;
  if (EMAIL_RE.test(trimmed) || IPV4_RE.test(trimmed) || PHONE_RE.test(trimmed)) return REDACTED;
  try {
    const url = new URL(trimmed);
    if (url.search || url.username || url.password) {
      url.search = '';
      url.username = '';
      url.password = '';
      url.pathname = url.pathname.replace(/\/[^/]{16,}/g, '/[Redacted]');
      return url.toString();
    }
  } catch {
    // not a URL
  }
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[MaxDepth]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    const classified = classifyProviderError(value);
    const entry: Record<string, unknown> = {
      name: value.name,
      code: classified.code,
      retryable: classified.retryable,
    };
    if (process.env.NODE_ENV !== 'production' && value.stack) {
      entry.stack = redactString(value.stack.split('\n').slice(0, 8).join('\n'));
    }
    if (value.cause !== undefined) entry.cause = redact(value.cause, depth + 1);
    return entry;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function serializeOutboxError(error: unknown): string {
  const classified = classifyProviderError(error);
  return JSON.stringify({ code: classified.code, retryable: classified.retryable });
}
