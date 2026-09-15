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

  it('builds a template payload when an approved template is configured', () => {
    const payload = buildMetaWhatsAppPayload(
      { to: '33612345678', title: 'Nouvelle affectation', message: 'Match U17 samedi à 15h' },
      { WHATSAPP_META_TEMPLATE_NAME: 'planning_notification', WHATSAPP_META_TEMPLATE_LANGUAGE: 'fr' },
    );
    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: '33612345678',
      type: 'template',
      template: { name: 'planning_notification', language: { code: 'fr' } },
    });
  });

  it('omet eventType, eventId et urgence du webhook sauf drapeau explicite', () => {
    const message = {
      to: '33612345678',
      title: 'Titre',
      message: 'Corps',
      eventType: 'officiel',
      eventId: 'match-1',
      urgency: 'critical',
    };
    expect(webhookIncludesEventContext({})).toBe(false);
    expect(buildWebhookWhatsAppPayload(message, {})).toEqual({
      to: '33612345678',
      text: 'Titre\nCorps',
    });
    expect(buildWebhookWhatsAppPayload(message, { WHATSAPP_WEBHOOK_INCLUDE_EVENT_CONTEXT: 'true' })).toEqual({
      to: '33612345678',
      text: 'Titre\nCorps',
      eventType: 'officiel',
      eventId: 'match-1',
      urgency: 'critical',
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
    await sendWhatsAppNotification({ to: '0612345678', title: 'Titre', message: 'Secret' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('journalise un échec sans numéro ni contenu', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
    vi.stubEnv('WHATSAPP_PROVIDER', 'webhook');
    vi.stubEnv('NOTIFICATION_WHATSAPP_WEBHOOK_URL', 'https://provider.example/whatsapp');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));

    await sendWhatsAppNotification({
      to: '0612345678',
      title: 'Affectation confidentielle',
      message: 'Ne jamais logger ceci',
      eventType: 'officiel',
      eventId: 'secret-event',
    });

    const joined = errors.join('\n');
    expect(joined).toMatch(/status 502/);
    expect(joined).not.toMatch(/0612345678/);
    expect(joined).not.toMatch(/33612345678/);
    expect(joined).not.toMatch(/Affectation confidentielle/);
    expect(joined).not.toMatch(/Ne jamais logger/);
    expect(joined).not.toMatch(/secret-event/);
  });
});
