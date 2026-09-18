import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMetaWhatsAppPayload,
  buildWebhookWhatsAppPayload,
  configuredWhatsAppProvider,
  isWhatsAppGloballyEnabled,
  normalizeWhatsAppRecipient,
  sendWhatsAppNotification,
  webhookIncludesEventContext,
} from './whatsapp';

const META_ENV = {
  WHATSAPP_PROVIDER: 'meta',
  WHATSAPP_META_PHONE_NUMBER_ID: '123',
  WHATSAPP_META_ACCESS_TOKEN: 'secret',
  WHATSAPP_META_GRAPH_VERSION: 'v23.0',
};

describe('WhatsApp provider infrastructure (issue #17)', () => {
  it('normalizes French local and international phone numbers for Meta', () => {
    expect(normalizeWhatsAppRecipient('06 12 34 56 78', '33')).toBe('33612345678');
    expect(normalizeWhatsAppRecipient('+33 6 12 34 56 78', '33')).toBe('33612345678');
    expect(normalizeWhatsAppRecipient('0033 6 12 34 56 78', '33')).toBe('33612345678');
  });

  it('n’active jamais le canal à partir des seuls secrets', () => {
    expect(configuredWhatsAppProvider({})).toBe('disabled');
    expect(configuredWhatsAppProvider({
      WHATSAPP_META_PHONE_NUMBER_ID: '123',
      WHATSAPP_META_ACCESS_TOKEN: 'secret',
      WHATSAPP_META_GRAPH_VERSION: 'v23.0',
    })).toBe('disabled');
    expect(configuredWhatsAppProvider({
      NOTIFICATION_WHATSAPP_WEBHOOK_URL: 'https://provider.example/whatsapp',
    })).toBe('disabled');
    expect(isWhatsAppGloballyEnabled({})).toBe(false);
  });

  it('refuse un provider inconnu ou une configuration incomplète', () => {
    expect(configuredWhatsAppProvider({ WHATSAPP_PROVIDER: 'twilio' })).toBe('disabled');
    expect(configuredWhatsAppProvider({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_META_PHONE_NUMBER_ID: '123' })).toBe('disabled');
    expect(configuredWhatsAppProvider({ WHATSAPP_PROVIDER: 'webhook' })).toBe('disabled');
    expect(configuredWhatsAppProvider({ ...META_ENV, WHATSAPP_PROVIDER: 'disabled' })).toBe('disabled');
  });

  it('n’active Meta ou le webhook que si le provider est explicite et complet', () => {
    expect(configuredWhatsAppProvider(META_ENV)).toBe('meta');
    expect(configuredWhatsAppProvider({
      WHATSAPP_PROVIDER: 'webhook',
      NOTIFICATION_WHATSAPP_WEBHOOK_URL: 'https://provider.example/whatsapp',
    })).toBe('webhook');
  });

  it('builds a template payload when an approved template is configured, from the allowlisted body only', () => {
    const payload = buildMetaWhatsAppPayload(
      { to: '33612345678', templateId: 'planning' },
      { WHATSAPP_META_TEMPLATE_NAME: 'planning_notification', WHATSAPP_META_TEMPLATE_LANGUAGE: 'fr' },
    );
    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: '33612345678',
      type: 'template',
      template: { name: 'planning_notification', language: { code: 'fr' } },
    });
  });

  it('n’envoie jamais de texte libre — seulement le corps du gabarit allowlisté (issue #27)', () => {
    const payload = buildMetaWhatsAppPayload(
      { to: '33612345678', templateId: 'planning' },
      {},
    ) as { text: { body: string } };
    expect(payload.text.body).toBe('Une mise à jour de planning vous concerne sur Clubika. Connectez-vous pour la consulter.');
  });

  it('omet templateId du webhook sauf drapeau explicite, et n’envoie jamais d’eventType/eventId (issue #17, #27)', () => {
    const message = { to: '33612345678', templateId: 'planning' as const };
    expect(webhookIncludesEventContext({})).toBe(false);
    expect(buildWebhookWhatsAppPayload(message, {})).toEqual({
      to: '33612345678',
      text: 'Une mise à jour de planning vous concerne sur Clubika. Connectez-vous pour la consulter.',
    });
    expect(buildWebhookWhatsAppPayload(message, { WHATSAPP_WEBHOOK_INCLUDE_EVENT_CONTEXT: 'true' })).toEqual({
      to: '33612345678',
      text: 'Une mise à jour de planning vous concerne sur Clubika. Connectez-vous pour la consulter.',
      templateId: 'planning',
    });
  });
});

describe('sendWhatsAppNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('n’appelle pas le réseau si le provider n’est pas explicite', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubEnv('WHATSAPP_META_PHONE_NUMBER_ID', '123');
    vi.stubEnv('WHATSAPP_META_ACCESS_TOKEN', 'secret');
    vi.stubEnv('WHATSAPP_META_GRAPH_VERSION', 'v23.0');
    await sendWhatsAppNotification({ to: '0612345678', templateId: 'planning' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('journalise un échec sans numéro ni contenu', async () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    vi.stubEnv('WHATSAPP_PROVIDER', 'webhook');
    vi.stubEnv('NOTIFICATION_WHATSAPP_WEBHOOK_URL', 'https://provider.example/whatsapp');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));

    try {
      await sendWhatsAppNotification({ to: '0612345678', templateId: 'planning' });
    } finally {
      process.stderr.write = original;
    }

    const joined = chunks.join('\n');
    expect(joined).toContain('"event":"whatsapp.delivery_failed"');
    expect(joined).toMatch(/"status":502/);
    expect(joined).not.toMatch(/0612345678/);
    expect(joined).not.toMatch(/33612345678/);
  });
});
