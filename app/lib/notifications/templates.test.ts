import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TEMPLATE_IDS,
  renderEmailNotification,
  renderPushNotification,
  renderWhatsAppNotification,
  resolveNotificationTemplateId,
} from './templates';

/**
 * Interdit toute fuite de contenu sensible dans un gabarit externe (issue #27) :
 * nom de personne, nom de club, rapport, discussion, refus, indisponibilité,
 * présence, téléphone, donnée de santé. Ce test doit échouer si un futur gabarit
 * (ou une régression) réintroduit l'une de ces catégories.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /rapport/i,
  /\bchat\b/i,
  /discussion/i,
  /refus/i,
  /indisponib/i,
  /présence/i,
  /telephone|téléphone|\+33|0[1-9](\s?\d{2}){4}/i,
  /santé|medical|médical/i,
];

/** Valeurs sentinelles réalistes : un gabarit ne doit jamais pouvoir les afficher. */
const SENTINEL_VALUES = [
  'Amine Brahmi',
  'FC Sentinel Club',
  'sentinel.user@example.test',
  '+33612345678',
  'Salle de bain 3, allergies pénicilline',
  'Refus de la demande de remplacement',
  'Indisponible du 12 au 15',
];

function assertSafe(text: string) {
  for (const pattern of FORBIDDEN_PATTERNS) {
    expect(text).not.toMatch(pattern);
  }
  for (const sentinel of SENTINEL_VALUES) {
    expect(text).not.toContain(sentinel);
  }
}

describe('gabarits de notification externes (issue #27)', () => {
  it.each(NOTIFICATION_TEMPLATE_IDS)('gabarit "%s" — push par défaut est générique et sûr', (templateId) => {
    const push = renderPushNotification(templateId);
    expect(push).toMatchSnapshot();
    assertSafe(push.title);
    assertSafe(push.body);
  });

  it.each(NOTIFICATION_TEMPLATE_IDS)('gabarit "%s" — email par défaut est générique et sûr', (templateId) => {
    const email = renderEmailNotification(templateId);
    expect(email).toMatchSnapshot();
    assertSafe(email.subject);
    assertSafe(email.body);
  });

  it.each(NOTIFICATION_TEMPLATE_IDS)('gabarit "%s" — WhatsApp par défaut est générique et sûr', (templateId) => {
    const whatsapp = renderWhatsAppNotification(templateId);
    expect(whatsapp).toMatchSnapshot();
    assertSafe(whatsapp.body);
  });

  it.each(NOTIFICATION_TEMPLATE_IDS)('gabarit "%s" — aperçu détaillé (opt-in) reste générique et sûr', (templateId) => {
    const push = renderPushNotification(templateId, { detailed: true });
    const email = renderEmailNotification(templateId, { detailed: true });
    const whatsapp = renderWhatsAppNotification(templateId, { detailed: true });
    expect({ push, email, whatsapp }).toMatchSnapshot();
    assertSafe(push.title);
    assertSafe(push.body);
    assertSafe(email.subject);
    assertSafe(email.body);
    assertSafe(whatsapp.body);
  });

  it('ne concatène jamais un texte utilisateur, même sentinelle, dans le rendu', () => {
    // Les fonctions de rendu n'acceptent même pas de texte libre en entrée : impossible
    // de leur faire produire un contenu autre que le gabarit allowlisté.
    for (const templateId of NOTIFICATION_TEMPLATE_IDS) {
      const push = renderPushNotification(templateId, { detailed: true });
      const email = renderEmailNotification(templateId, { detailed: true });
      const whatsapp = renderWhatsAppNotification(templateId, { detailed: true });
      for (const sentinel of SENTINEL_VALUES) {
        expect(push.title).not.toContain(sentinel);
        expect(push.body).not.toContain(sentinel);
        expect(email.subject).not.toContain(sentinel);
        expect(email.body).not.toContain(sentinel);
        expect(whatsapp.body).not.toContain(sentinel);
      }
    }
  });

  describe('resolveNotificationTemplateId', () => {
    it('associe les types connus à un gabarit sûr, jamais au texte brut', () => {
      expect(resolveNotificationTemplateId('chat-mention')).toBe('activity');
      expect(resolveNotificationTemplateId('chat-dm')).toBe('activity');
      expect(resolveNotificationTemplateId('assignment-created')).toBe('planning');
      expect(resolveNotificationTemplateId('availability-updated')).toBe('planning');
      expect(resolveNotificationTemplateId('official_match_updated')).toBe('planning');
      expect(resolveNotificationTemplateId('post-event-report')).toBe('planning');
      expect(resolveNotificationTemplateId('user-deactivated-with-assignments')).toBe('planning');
      expect(resolveNotificationTemplateId('privacy-security')).toBe('account');
      expect(resolveNotificationTemplateId('account-closure-requested')).toBe('account');
      expect(resolveNotificationTemplateId('privileged-role-changed')).toBe('account');
    });

    it('retombe sur "generic" (le plus prudent) pour un type inconnu ou vide', () => {
      expect(resolveNotificationTemplateId('un-type-jamais-vu')).toBe('generic');
      expect(resolveNotificationTemplateId(null)).toBe('generic');
      expect(resolveNotificationTemplateId(undefined)).toBe('generic');
      expect(resolveNotificationTemplateId('')).toBe('generic');
    });
  });
});
