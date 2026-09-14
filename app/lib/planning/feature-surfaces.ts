import type { PlanningFeatureFlags } from '@/lib/settings';

export interface PlanningFeatureSurface {
  /** Libellé affiché dans la configuration du club. */
  label: string;
  /** Phrase explicative affichée sous le libellé dans la configuration du club. */
  description: string;
  /** Pages ou sections d'interface masquées quand le flag est désactivé. */
  pages: string[];
  /** Routes API qui répondent 409 quand le flag est désactivé. */
  routes: string[];
}

/**
 * Registre unique et exhaustif de chaque fonctionnalité optionnelle (issue #279) :
 * libellé et description affichés dans la configuration du club, pages masquées et
 * routes gardées quand le flag est désactivé. `Record<keyof PlanningFeatureFlags, ...>`
 * force ce registre à rester exhaustif — ajouter un flag à `PlanningFeatureFlags` sans
 * l'y décrire est une erreur de compilation, jamais un oubli silencieux dans
 * l'interface de configuration. Sert de source unique pour la navigation, la
 * configuration et les tests de cohérence.
 */
export const PLANNING_FEATURE_SURFACES: Record<keyof PlanningFeatureFlags, PlanningFeatureSurface> = {
  assignmentValidation: {
    label: 'Validation des affectations',
    description: 'Contrôle les indisponibilités, conflits et types de personnes à l’enregistrement des affectations et au moment de publier le planning.',
    pages: [],
    routes: [],
  },
  publicationReadiness: {
    label: 'Contrôle avant publication',
    description: 'Empêche la publication d’un planning incomplet ou invalide.',
    pages: [],
    routes: [],
  },
  autoAssignment: {
    label: 'Auto-affectation',
    description: 'Autorise les suggestions d’affectation automatique sur les postes vacants.',
    pages: [],
    routes: ['app/api/planning/auto-assign/route.ts'],
  },
  automaticReminders: {
    label: 'Relances automatiques',
    description: 'Envoie les relances liées aux affectations en attente.',
    pages: [],
    routes: ['app/api/planning/reminders/route.ts', 'app/api/cron/planning-reminders/route.ts'],
  },
  assignmentSwaps: {
    label: 'Échanges d’affectation',
    description: 'Autorise les demandes et validations de remplacement.',
    pages: ['/club/planning/echanges', '/mon-planning/mes-echanges'],
    routes: ['app/api/planning/assignment-swaps/route.ts', 'app/api/me/assignment-swaps/route.ts'],
  },
  attendanceTracking: {
    label: 'Suivi des présences',
    description: 'Permet de saisir présence, absence, excuse ou remplacement.',
    pages: [],
    routes: ['app/api/planning/attendance/route.ts'],
  },
  recurringEvents: {
    label: 'Événements récurrents',
    description: 'Active la création et la modification des séries.',
    pages: ['/club/planning/recurrent'],
    routes: ['app/api/recurring-events/route.ts', 'app/api/recurring-events/[seriesId]/route.ts'],
  },
  publicSharing: {
    label: 'Partages publics',
    description: 'Autorise la création et la consultation des liens publics.',
    pages: ['/club/planning/partage'],
    routes: ['app/api/planning/shares/route.ts', 'app/api/public/planning/[token]/route.ts'],
  },
  scraperSync: {
    label: 'Synchronisation du scraper',
    description: 'Autorise l’import des matchs officiels vers MariaDB. En production, SPORTCORICO_SYNC_ENABLED=true est aussi requis (issues #4 et #30).',
    pages: [],
    routes: ['app/api/scraper/route.ts', 'app/api/cron/scraper/route.ts'],
  },
  officialMatchesCurrentWeekendOnly: {
    label: 'Matchs officiels du week-end uniquement',
    description: 'N’affiche que les matchs scrapés du week-end en cours (samedi–dimanche). Les matchs passés restent visibles dans les Archives.',
    pages: [],
    routes: [],
  },
  eventChat: {
    label: 'Chat des événements',
    description: 'Autorise les salons liés aux événements du club.',
    pages: ['Espace événement · chat'],
    routes: ['app/api/chat/events/route.ts'],
  },
  travelAndWeather: {
    label: 'Trajet et météo',
    description: 'Active les estimations de trajet et la météo événementielle. En production, ROUTING_ENABLED / OPEN_METEO_ENABLED et une URL explicite sont aussi requis (issue #30).',
    pages: ['Espace événement · météo'],
    routes: ['app/api/planning/travel/route.ts', 'app/api/planning/weather/route.ts'],
  },
  calendarExport: {
    label: 'Export calendrier',
    description: 'Autorise les flux iCalendar personnels.',
    pages: [],
    routes: ['app/api/ical/[token]/route.ts'],
  },
  collaboration: {
    label: 'Collaboration',
    description: 'Active commentaires, tâches et comptes rendus du planning.',
    pages: ['Espace événement · commentaires, tâches, documents, rapports'],
    routes: [
      'app/api/planning/events/[eventType]/[eventId]/collaboration/route.ts',
      'app/api/planning/events/[eventType]/[eventId]/reports/route.ts',
      'app/api/planning/events/[eventType]/[eventId]/attachments/route.ts',
      'app/api/planning/attachments/[id]/route.ts',
    ],
  },
  requireArbitreForPublication: {
    label: 'Arbitre obligatoire avant publication',
    description: 'Exige au moins un arbitre actif sur les matchs officiels et amicaux.',
    pages: [],
    routes: [],
  },
  requireEncadrantForPublication: {
    label: 'Encadrant obligatoire avant publication',
    description: 'Exige au moins un encadrant actif avant publication.',
    pages: [],
    routes: [],
  },
  requireAccompagnateurForPublication: {
    label: 'Accompagnateur obligatoire avant publication',
    description: 'Exige au moins un accompagnateur actif sur les matchs officiels et amicaux.',
    pages: [],
    routes: [],
  },
};
