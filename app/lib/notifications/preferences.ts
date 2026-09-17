export type NotificationChannel = 'inApp' | 'push' | 'email' | 'whatsapp';
export type NotificationUrgency = 'normal' | 'important' | 'critical';

export interface NotificationPreferences {
  inApp: boolean;
  push: boolean;
  email: boolean;
  whatsapp: boolean;
  urgencyThreshold: NotificationUrgency;
  eventTypes: string[];
  /** Sons de messagerie instantanée à l'envoi/réception (issue #269), activés par défaut. */
  chatSounds: boolean;
  /**
   * Aperçu détaillé du push (issue #27) : opt-in explicite, granulaire et révocable.
   * Par défaut (false), le push affiche un texte générique sans nom, club, contenu,
   * motif ni détail d'événement, y compris sur l'écran verrouillé.
   */
  pushDetailedPreview: boolean;
  /** Aperçu détaillé de l'email (issue #27), même contrat que `pushDetailedPreview`. */
  emailDetailedPreview: boolean;
}

/**
 * Par défaut, les canaux externes (push, email, WhatsApp) sont **désactivés** (issue #27) :
 * seule la notification in-app (consultée après authentification) est active par défaut.
 * L'utilisateur active chaque canal externe explicitement, et peut le retirer à tout moment
 * depuis `/api/me/notification-preferences` (`NotificationSettingsView`).
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  inApp: true,
  push: false,
  email: false,
  whatsapp: false,
  urgencyThreshold: 'normal',
  eventTypes: [],
  chatSounds: true,
  pushDetailedPreview: false,
  emailDetailedPreview: false,
};

const URGENCY_RANK: Record<NotificationUrgency, number> = { normal: 0, important: 1, critical: 2 };

function isUrgency(value: unknown): value is NotificationUrgency {
  return value === 'normal' || value === 'important' || value === 'critical';
}

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  const raw = value as Record<string, unknown>;
  const eventTypes = Array.isArray(raw.eventTypes)
    ? [...new Set(raw.eventTypes.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 30)
    : [];
  const inApp = raw.inApp !== false;
  // Canaux externes : opt-in explicite uniquement (issue #27). `push` reste conditionné
  // à `inApp` (source durable pour le clic de la notification système), mais n'est plus
  // jamais activé par défaut — seule une valeur `=== true` explicite l'active.
  const push = inApp && raw.push === true;
  const email = raw.email === true;
  const whatsapp = raw.whatsapp === true;
  return {
    inApp,
    push,
    email,
    whatsapp,
    urgencyThreshold: isUrgency(raw.urgencyThreshold) ? raw.urgencyThreshold : 'normal',
    eventTypes,
    chatSounds: raw.chatSounds !== false,
    // Aperçus détaillés : opt-in explicite, et sans effet tant que le canal correspondant
    // n'est pas lui-même actif (retirer le canal retire aussi son aperçu détaillé).
    pushDetailedPreview: push && raw.pushDetailedPreview === true,
    emailDetailedPreview: email && raw.emailDetailedPreview === true,
  };
}

export function selectedNotificationChannels(
  preferences: NotificationPreferences,
  input: { urgency?: NotificationUrgency; eventType?: string | null },
): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (preferences.inApp) channels.push('inApp');
  const urgency = input.urgency ?? 'normal';
  const passesUrgency = URGENCY_RANK[urgency] >= URGENCY_RANK[preferences.urgencyThreshold];
  const passesEventType = !input.eventType || preferences.eventTypes.length === 0 || preferences.eventTypes.includes(input.eventType);
  if (!passesUrgency || !passesEventType) return channels;
  if (preferences.push) channels.push('push');
  if (preferences.email) channels.push('email');
  if (preferences.whatsapp) channels.push('whatsapp');
  return channels;
}
