import { guardedFetch } from '@/lib/compliance/external-services';

export type WhatsAppProvider = 'disabled' | 'webhook' | 'meta';
type WhatsAppEnvironment = Readonly<Record<string, string | undefined>>;

export interface WhatsAppNotificationMessage {
  to: string;
  title: string;
  message: string;
  eventType?: string | null;
  eventId?: string | null;
  urgency?: string | null;
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

export function normalizeWhatsAppRecipient(
  value: string,
  defaultCountryCode = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.trim() || '33',
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const normalized = digits(trimmed);
    return normalized.length >= 8 && normalized.length <= 15 ? normalized : null;
  }
  if (trimmed.startsWith('00')) {
    const normalized = digits(trimmed.slice(2));
    return normalized.length >= 8 && normalized.length <= 15 ? normalized : null;
  }

  const local = digits(trimmed);
  if (!local) return null;
  const withoutLeadingZero = local.startsWith('0') ? local.slice(1) : local;
  const normalized = `${digits(defaultCountryCode)}${withoutLeadingZero}`;
  return normalized.length >= 8 && normalized.length <= 15 ? normalized : null;
}

function metaConfigured(env: WhatsAppEnvironment): boolean {
  return Boolean(
    env.WHATSAPP_META_PHONE_NUMBER_ID?.trim()
    && env.WHATSAPP_META_ACCESS_TOKEN?.trim()
    && env.WHATSAPP_META_GRAPH_VERSION?.trim(),
  );
}

/**
 * Le canal n’est actif que si `WHATSAPP_PROVIDER` vaut exactement `meta` ou `webhook`
 * **et** que la configuration correspondante est complète. Les secrets seuls
 * n’activent rien (barrière commune issue #30 ; détail opt-in #17).
 */
export function configuredWhatsAppProvider(env: WhatsAppEnvironment = process.env): WhatsAppProvider {
  const requested = env.WHATSAPP_PROVIDER?.trim().toLowerCase();
  if (!requested || requested === 'disabled') return 'disabled';
  if (requested === 'meta') return metaConfigured(env) ? 'meta' : 'disabled';
  if (requested === 'webhook') return env.NOTIFICATION_WHATSAPP_WEBHOOK_URL?.trim() ? 'webhook' : 'disabled';
  return 'disabled';
}

export function buildMetaWhatsAppPayload(
  message: WhatsAppNotificationMessage,
  env: WhatsAppEnvironment = process.env,
): Record<string, unknown> {
  const templateName = env.WHATSAPP_META_TEMPLATE_NAME?.trim();
  if (templateName) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: env.WHATSAPP_META_TEMPLATE_LANGUAGE?.trim() || 'fr' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: message.title.slice(0, 1024) },
            { type: 'text', text: message.message.slice(0, 1024) },
          ],
        }],
      },
    };
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: message.to,
    type: 'text',
    text: { body: `${message.title}\n${message.message}`.slice(0, 4096), preview_url: false },
  };
}

async function deliverMeta(message: WhatsAppNotificationMessage): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_META_PHONE_NUMBER_ID?.trim();
  const token = process.env.WHATSAPP_META_ACCESS_TOKEN?.trim();
  const graphVersion = process.env.WHATSAPP_META_GRAPH_VERSION?.trim();
  if (!phoneNumberId || !token || !graphVersion) return;

  const response = await guardedFetch(
    'whatsapp',
    `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMetaWhatsAppPayload(message)),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) console.error(`Notification WhatsApp meta failed with status ${response.status}`);
}

async function deliverWebhook(message: WhatsAppNotificationMessage): Promise<void> {
  const url = process.env.NOTIFICATION_WHATSAPP_WEBHOOK_URL?.trim();
  if (!url) return;
  const token = process.env.NOTIFICATION_WHATSAPP_WEBHOOK_TOKEN?.trim();
  const response = await guardedFetch('whatsapp', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      to: message.to,
      text: `${message.title}\n${message.message}`,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) console.error(`Notification WhatsApp webhook failed with status ${response.status}`);
}

export async function sendWhatsAppNotification(message: WhatsAppNotificationMessage): Promise<void> {
  const recipient = normalizeWhatsAppRecipient(message.to);
  if (!recipient) return;
  const normalized = { ...message, to: recipient };
  try {
    const provider = configuredWhatsAppProvider();
    if (provider === 'meta') await deliverMeta(normalized);
    if (provider === 'webhook') await deliverWebhook(normalized);
  } catch {
    console.error('Notification WhatsApp delivery failed');
  }
}