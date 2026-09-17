/**
 * Gabarits de notification externes, allowlistés par canal (issue #27).
 *
 * Les canaux externes (push, email, WhatsApp) ne reçoivent jamais le titre/message
 * libre saisi côté in-app : ils sont rendus depuis un petit ensemble de gabarits
 * statiques, choisis à partir de la *catégorie* de l'événement (`NotificationTemplateId`),
 * jamais depuis une concaténation de texte utilisateur (nom, club, contenu de
 * discussion, motif de refus, indisponibilité, présence, téléphone, donnée de
 * santé…). Le détail réel reste dans la notification in-app (`notifications`),
 * accessible uniquement après authentification + contrôle tenant/objet — voir
 * `app/api/notifications/[id]/open/route.ts`.
 *
 * Le mode « aperçu détaillé » (opt-in explicite, révocable — `preferences.ts`)
 * ajoute uniquement un intitulé de catégorie (« Planning », « Compte »…) au
 * gabarit générique : jamais de texte libre, conformément au critère
 * « aucune concaténation directe de texte utilisateur », qui s'applique
 * indépendamment de ce réglage.
 */

export type NotificationTemplateId = 'generic' | 'planning' | 'activity' | 'account';

export const NOTIFICATION_TEMPLATE_IDS: readonly NotificationTemplateId[] = [
  'generic',
  'planning',
  'activity',
  'account',
] as const;

/** Intitulé de catégorie, affiché uniquement en mode aperçu détaillé (opt-in). */
export const NOTIFICATION_TEMPLATE_LABELS: Record<NotificationTemplateId, string> = {
  generic: 'Clubika',
  planning: 'Planning',
  activity: 'Activité',
  account: 'Compte',
};

interface PushTemplate {
  title: string;
  body: string;
}

interface EmailTemplate {
  subject: string;
  body: string;
}

interface WhatsAppTemplate {
  body: string;
}

interface NotificationTemplate {
  push: PushTemplate;
  email: EmailTemplate;
  whatsapp: WhatsAppTemplate;
}

/**
 * Contenu strictement générique : aucun nom, aucun nom de club, aucun contenu de
 * rapport/discussion, aucun motif de refus, aucune indisponibilité/présence,
 * aucun téléphone, aucune donnée de santé. Un test de non-régression
 * (`templates.test.ts`) échoue si l'une de ces catégories de mots apparaît.
 */
const NOTIFICATION_TEMPLATES: Record<NotificationTemplateId, NotificationTemplate> = {
  generic: {
    push: { title: 'Clubika', body: 'Vous avez une nouvelle notification. Ouvrez l’application pour la consulter.' },
    email: {
      subject: 'Nouvelle notification Clubika',
      body: 'Une mise à jour vous concerne. Connectez-vous à Clubika pour en consulter le détail.',
    },
    whatsapp: { body: 'Vous avez une nouvelle notification Clubika. Connectez-vous à l’application pour la consulter.' },
  },
  planning: {
    push: { title: 'Clubika', body: 'Une mise à jour de planning vous concerne. Ouvrez l’application pour la consulter.' },
    email: {
      subject: 'Mise à jour de planning',
      body: 'Le planning a été mis à jour. Connectez-vous à Clubika pour en consulter le détail.',
    },
    whatsapp: { body: 'Une mise à jour de planning vous concerne sur Clubika. Connectez-vous pour la consulter.' },
  },
  activity: {
    push: { title: 'Clubika', body: 'Une nouvelle activité vous concerne. Ouvrez l’application pour la consulter.' },
    email: {
      subject: 'Nouvelle activité Clubika',
      body: 'Une nouvelle activité vous concerne. Connectez-vous à Clubika pour en consulter le détail.',
    },
    whatsapp: { body: 'Une nouvelle activité vous concerne sur Clubika. Connectez-vous pour la consulter.' },
  },
  account: {
    push: { title: 'Clubika', body: 'Une mise à jour concernant votre compte est disponible. Ouvrez l’application pour la consulter.' },
    email: {
      subject: 'Mise à jour de votre compte Clubika',
      body: 'Une mise à jour concernant votre compte est disponible. Connectez-vous à Clubika pour en consulter le détail.',
    },
    whatsapp: { body: 'Une mise à jour concernant votre compte Clubika est disponible. Connectez-vous pour la consulter.' },
  },
};

/**
 * Association type métier → gabarit, par préfixe/valeur (jamais par interpolation).
 * Un type inconnu (nouvelle fonctionnalité ajoutée sans mise à jour de cette table)
 * retombe sur `generic`, le gabarit le plus prudent — jamais une erreur, jamais
 * un texte non allowlisté.
 */
function isTemplateId(value: string): value is NotificationTemplateId {
  return (NOTIFICATION_TEMPLATE_IDS as readonly string[]).includes(value);
}

const ACCOUNT_TYPES = new Set([
  'privacy-security',
  'privacy-request',
  'rectification',
  'portability',
  'account-closure-requested',
  'account-closure-processed',
  'privileged-role-changed',
]);

export function resolveNotificationTemplateId(type: string | null | undefined): NotificationTemplateId {
  const value = (type ?? '').trim();
  if (!value) return 'generic';
  if (isTemplateId(value)) return value;
  if (value.startsWith('chat-')) return 'activity';
  if (ACCOUNT_TYPES.has(value)) return 'account';
  if (
    value.startsWith('planning-')
    || value.startsWith('assignment')
    || value.startsWith('availability')
    || value.startsWith('official_match')
    || value === 'post-event-report'
    || value === 'user-deactivated-with-assignments'
  ) {
    return 'planning';
  }
  return 'generic';
}

function templateFor(templateId: NotificationTemplateId): NotificationTemplate {
  return NOTIFICATION_TEMPLATES[templateId] ?? NOTIFICATION_TEMPLATES.generic;
}

export interface RenderOptions {
  /** Aperçu détaillé (opt-in explicite, révocable) : ajoute l'intitulé de catégorie, jamais de texte libre. */
  detailed?: boolean;
}

export function renderPushNotification(templateId: NotificationTemplateId, options: RenderOptions = {}): PushTemplate {
  const template = templateFor(templateId).push;
  if (!options.detailed) return { ...template };
  return { title: NOTIFICATION_TEMPLATE_LABELS[templateId] ?? template.title, body: template.body };
}

export function renderEmailNotification(templateId: NotificationTemplateId, options: RenderOptions = {}): EmailTemplate {
  const template = templateFor(templateId).email;
  if (!options.detailed) return { ...template };
  const label = NOTIFICATION_TEMPLATE_LABELS[templateId];
  return { subject: label ? `${label} — ${template.subject}` : template.subject, body: template.body };
}

export function renderWhatsAppNotification(templateId: NotificationTemplateId, options: RenderOptions = {}): WhatsAppTemplate {
  const template = templateFor(templateId).whatsapp;
  if (!options.detailed) return { ...template };
  const label = NOTIFICATION_TEMPLATE_LABELS[templateId];
  return { body: label ? `${label} : ${template.body}` : template.body };
}
