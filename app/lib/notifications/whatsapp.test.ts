import { describe, expect, it } from 'vitest';
import {
  buildMetaWhatsAppPayload,
  configuredWhatsAppProvider,
  normalizeWhatsAppRecipient,
} from './whatsapp';

describe('WhatsApp provider infrastructure', () => {
  it('normalizes French local and international phone numbers for Meta', () => {
    expect(normalizeWhatsAppRecipient('06 12 34 56 78', '33')).toBe('33612345678');
    expect(normalizeWhatsAppRecipient('+33 6 12 34 56 78', '33')).toBe('33612345678');
    expect(normalizeWhatsAppRecipient('0033 6 12 34 56 78', '33')).toBe('33612345678');
  });

  it('n’active jamais le canal à partir des seuls secrets', () => {
    expect(configuredWhatsAppProvider({
      WHATSAPP_META_PHONE_NUMBER_ID: '123',
      WHATSAPP_META_ACCESS_TOKEN: 'secret',
      WHATSAPP_META_GRAPH_VERSION: 'v23.0',
    })).toBe('disabled');
    expect(configuredWhatsAppProvider({
      NOTIFICATION_WHATSAPP_WEBHOOK_URL: 'https://provider.example/whatsapp',
    })).toBe('disabled');
  });

  it('keeps Meta disabled until phone id, access token and Graph version are all configured', () => {
    expect(configuredWhatsAppProvider({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_META_PHONE_NUMBER_ID: '123' })).toBe('disabled');
    expect(configuredWhatsAppProvider({
      WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_META_PHONE_NUMBER_ID: '123',
      WHATSAPP_META_ACCESS_TOKEN: 'secret',
    })).toBe('disabled');
    expect(configuredWhatsAppProvider({
      WHATSAPP_PROVIDER: 'meta',
      WHATSAPP_META_PHONE_NUMBER_ID: '123',
      WHATSAPP_META_ACCESS_TOKEN: 'secret',
      WHATSAPP_META_GRAPH_VERSION: 'v23.0',
    })).toBe('meta');
    expect(configuredWhatsAppProvider({ WHATSAPP_PROVIDER: 'twilio' })).toBe('disabled');
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
});