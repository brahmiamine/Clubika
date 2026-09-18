/**
 * Notices publiques et identité d’éditeur (issue #12).
 *
 * Source unique pour `/mentions-legales`, `/confidentialite` et `/cgu`.
 * Aucune identité d’éditeur/hébergeur n’est inventée : les champs viennent
 * d’variables d’environnement. Aucune base juridique n’est choisie ici.
 * Les textes décrivent le comportement testé du logiciel, pas une conformité.
 */

import { LANDING_FOOTER_NOTE } from './public-claims';

export const LEGAL_PUBLIC_PATHS = ['/mentions-legales', '/confidentialite', '/cgu'] as const;

export const LEGAL_PAGE_TITLES = {
  '/mentions-legales': 'Mentions légales',
  '/confidentialite': 'Confidentialité',
  '/cgu': 'Conditions d’utilisation',
} as const;

export const CNIL_COMPLAINT_URL = 'https://www.cnil.fr/fr/plaintes';

export function isLegalPublicPath(pathname: string): boolean {
  return LEGAL_PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export interface LegalPublisherIdentity {
  name: string | null;
  legalForm: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  hostingProvider: string | null;
  hostingCountry: string | null;
  dpoEmail: string | null;
  complete: boolean;
}

export function readLegalPublisherIdentity(
  env: Record<string, string | undefined> = process.env,
): LegalPublisherIdentity {
  const name = env.LEGAL_PUBLISHER_NAME?.trim() || null;
  const address = env.LEGAL_PUBLISHER_ADDRESS?.trim() || null;
  const email = env.LEGAL_PUBLISHER_EMAIL?.trim() || null;
  return {
    name,
    legalForm: env.LEGAL_PUBLISHER_LEGAL_FORM?.trim() || null,
    address,
    email,
    phone: env.LEGAL_PUBLISHER_PHONE?.trim() || null,
    hostingProvider: env.LEGAL_HOSTING_PROVIDER?.trim() || null,
    hostingCountry: env.LEGAL_HOSTING_COUNTRY?.trim() || null,
    dpoEmail: env.LEGAL_DPO_EMAIL?.trim() || null,
    complete: Boolean(name && address && email),
  };
}

export const LEGAL_IDENTITY_INCOMPLETE =
  'L’identité de l’éditeur n’est pas configurée sur ce déploiement (LEGAL_PUBLISHER_NAME, LEGAL_PUBLISHER_ADDRESS, LEGAL_PUBLISHER_EMAIL). Cette page décrit le logiciel ; elle ne constitue pas des mentions légales complètes tant que l’exploitant n’a pas renseigné ces informations.';

export const LEGAL_NO_COMPLIANCE =
  'Ces pages décrivent le comportement observé de cette version. Elles ne constituent pas une attestation de conformité, un avis juridique, ni un choix de base légale.';

export const LEGAL_HUMAN_REVIEW =
  'Les textes et contrats restent soumis à une revue humaine et juridique (#12, #40) avant toute donnée réelle.';

export interface ProcessingEntry {
  id: string;
  title: string;
  purpose: string;
  data: string;
  sources: string;
  recipients: string;
  retention: string;
  rights: string;
  legalBasisStatus: 'unqualified';
}

/** Inventaire factuel aligné sur le code mergé (issues #9, #17, #22, #25, #26, #30). */
export const PROCESSING_INVENTORY: ProcessingEntry[] = [
  {
    id: 'accounts',
    title: 'Comptes club',
    purpose: 'Authentification, rôles, affectations, invitations.',
    data: 'E-mail, mot de passe hashé, nom d’affichage, téléphone optionnel, rôle, fonctions planning, clubId.',
    sources: 'Inscription sur invitation, création par un administrateur, fiches sans compte (#26).',
    recipients: 'Administrateurs du même club ; l’exploitant de la plateforme pour le support technique du tenant.',
    retention: 'Compte actif jusqu’à fermeture (#11) ou offboarding club (#25). Sessions révoquées : RETENTION_SESSIONS_DAYS (défaut 30).',
    rights: '/exercice-des-droits, /club/profil, /mon-planning/profil.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'non-account',
    title: 'Fiches sans compte',
    purpose: 'Organisation du planning et contact opérationnel sans créer d’accès.',
    data: 'Nom, téléphone optionnel (interdit sans provenance), provenance et finalité en enum fermé, preuve de notice (version, canal, date).',
    sources: 'Saisie admin, import CSV, listes de compétition.',
    recipients: 'Administrateurs du club. Téléphone masqué sur GET /api/users sauf révélation explicite.',
    retention: 'Jusqu’à opposition, effacement, ou purge des statuts unused/refused/orphan selon #9.',
    rights: '/droits-sans-compte.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'planning',
    title: 'Planning et affectations',
    purpose: 'Organisation des matchs, entraînements, plateaux et ressources humaines du club.',
    data: 'Événements, affectations, indisponibilités, commentaires d’espace, rapports post-événement.',
    sources: 'Saisie club, import SportCorico si le club et SPORTCORICO_SYNC_ENABLED l’autorisent.',
    recipients: 'Membres autorisés du club selon le rôle. SportCorico n’est contacté que si le sync est activé.',
    retention: 'Événements : données opérationnelles, hors job #9 (offboarding #25). Rapports : RETENTION_REPORTS_DAYS (365).',
    rights: 'Rectification via l’espace club ; demandes #22.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'chat',
    title: 'Chat',
    purpose: 'Messages privés, par événement et de groupe, isolés par club.',
    data: 'Texte (AES-256-GCM si APP_ENCRYPTION_KEY), pièces jointes non chiffrées par ce mécanisme, accusés de lecture.',
    sources: 'Utilisateurs du club.',
    recipients: 'Participants du fil. Pas de prestataire de messagerie tiers dans le produit.',
    retention: 'RETENTION_CHAT_DAYS (365) pour messages et pièces jointes chat.',
    rights: 'Demandes #22 ; fermeture de compte #11.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    purpose: 'Alerter d’une affectation, d’une modification ou d’un message.',
    data: 'Titre, texte, identifiant d’événement. E-mail si SMTP_ENABLED. WhatsApp seulement si WHATSAPP_PROVIDER et opt-in. Web Push si WEB_PUSH_ENABLED.',
    sources: 'Événements planning et chat.',
    recipients: 'Destinataire. Prestataire SMTP / Meta / endpoint push uniquement si le flux est activé (#30).',
    retention: 'In-app : RETENTION_NOTIFICATIONS_DAYS (180). Push inactifs : RETENTION_PUSH_DAYS (365). Outbox : RETENTION_OUTBOX_DAYS (30).',
    rights: 'Préférences utilisateur ; opposition #22 coupe les canaux externes non essentiels.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'public-share',
    title: 'Liens publics et iCal',
    purpose: 'Partager un extrait de calendrier sans compte.',
    data: 'Jeton hashé SHA-256, dates, lieux, noms d’affectés possibles. Pas de téléphone, personId, commentaires, rapports ni audit.',
    sources: 'Administrateur club.',
    recipients: 'Toute personne qui possède l’URL pendant la durée de vie du lien (1 à 90 jours).',
    retention: 'RETENTION_PUBLIC_SHARES_DAYS (90). iCal personnel : jeton par utilisateur.',
    rights: 'Révocation du lien par un administrateur.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'privacy-requests',
    title: 'Demandes de droits',
    purpose: 'Enregistrer accès, portabilité, rectification, restriction, opposition, effacement.',
    data: 'Empreinte SHA-256 de l’e-mail, type, clubId, état. Pas de pièce d’identité numérisée.',
    sources: '/exercice-des-droits, /droits-sans-compte, espace profil.',
    recipients: 'Administrateurs du club concerné.',
    retention: 'File interne jusqu’à clôture humaine. Jetons d’export : 15 min, usage unique.',
    rights: 'Le canal est lui-même l’exercice du droit.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'audit',
    title: 'Journaux d’audit minimisés',
    purpose: 'Tracer une action d’écriture sur le planning, sans recopier le contenu métier.',
    data: 'Identifiants, action, horodatage. Payloads expurgés (#8, #20).',
    sources: 'Actions administrateur / système.',
    recipients: 'Administrateurs du club.',
    retention: 'RETENTION_AUDIT_DAYS (365).',
    rights: 'Demandes #22.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'backups',
    title: 'Sauvegardes et dumps',
    purpose: 'Reprise d’activité hors application (opérateur).',
    data: 'Dump MariaDB chiffré (.sql.gz.enc) si l’opérateur utilise clubika_backup.',
    sources: 'Base du déploiement.',
    recipients: 'Exploitant / hébergeur selon le contrat d’hébergement, non choisi par cette page.',
    retention: 'Hors application. Une purge SQL ne rétroagit pas sur un dump déjà copié (docs/retention.md).',
    rights: 'À traiter par l’exploitant sur les copies hors ligne.',
    legalBasisStatus: 'unqualified',
  },
  {
    id: 'telemetry-optional',
    title: 'Météo, routage, logos distants',
    purpose: 'Enrichir un événement (prévision, trajet, blason).',
    data: 'Coordonnées ou octets d’image. Pas d’identité nominative dans ces appels.',
    sources: 'Événement planning, si OPEN_METEO_ENABLED / ROUTING_ENABLED / LOGO_PROXY_ENABLED.',
    recipients: 'Hôte allowlisté uniquement. Désactivé par défaut (#30).',
    retention: 'Pas de copie persistante du flux chez Clubika au-delà du cache événementiel.',
    rights: 'Désactivation par configuration ; pas de profilage.',
    legalBasisStatus: 'unqualified',
  },
];

export const LEGAL_BASIS_BLOCKER =
  'Base juridique : non qualifiée. Le responsable du traitement doit documenter la base (art. 6) et, le cas échéant, l’analyse d’intérêt légitime. Clubika n’en choisit aucune.';

export const ROLE_QUALIFICATION_BLOCKER =
  'Qualification RGPD (responsable, sous-traitant, responsabilité conjointe art. 26) : non tranchée. Deux hypothèses sont décrites dans docs/governance/roles-responsabilites.md. Aucune n’est publiée comme modèle retenu.';

export const DPO_BLOCKER =
  'Désignation d’un DPO (art. 37) : non décidée. Un contact DPO n’est affiché que si LEGAL_DPO_EMAIL est configuré ; son absence ne signifie pas qu’aucun DPO n’est requis.';

export interface CguSection {
  title: string;
  body: string;
}

export const CGU_SECTIONS: CguSection[] = [
  {
    title: 'Objet',
    body: 'Clubika est un logiciel de planning, d’affectations et de communication pour des clubs de football amateurs. Ces conditions décrivent l’usage du service tel qu’implémenté. Elles n’ont pas été validées par un avocat et ne doivent pas être présentées comme un contrat opposable tant que #40 n’a pas donné son accord.',
  },
  {
    title: 'Comptes et clubs',
    body: 'Un club est un tenant isolé par clubId. L’accès se fait par invitation ou création d’un administrateur. Quatre rôles existent : administrateur (écriture), arbitre, encadrant, accompagnateur (lecture de leurs affectations). Un compte plateforme distinct supervise les tenants.',
  },
  {
    title: 'Données',
    body: 'Les catégories collectées sont listées dans /confidentialite. Les fiches sans compte, invitations, chat, notifications, partages publics et journaux d’audit suivent les règles du code, pas une politique inventée ici. La rétention initiale est dans docs/retention.md ; elle n’est pas une obligation légale.',
  },
  {
    title: 'Interdictions d’usage',
    body: 'Il est interdit d’utiliser le service pour déposer des données de santé structurées (retirées, #7), de réactiver SportCorico ou WhatsApp sans contrat et opt-in, ou de contourner l’isolation entre clubs.',
  },
  {
    title: 'Disponibilité et responsabilité',
    body: 'Aucun engagement de niveau de service n’est publié ici. Les sauvegardes, l’hébergement et la continuité d’activité relèvent de l’exploitant du déploiement, pas d’une clause générique.',
  },
  {
    title: 'Acceptation',
    body: 'Cocher une case d’invitation (« accusé de notice ») enregistre une preuve de présentation (version, canal, date). Cela n’est pas traité comme un consentement universel à tous les traitements.',
  },
];

export const LEGAL_TRANSFERS_NOTE =
  'Transferts hors UE : aucun n’est activé par défaut. Un flux SMTP, WhatsApp, Web Push, météo, routage ou proxy de logos n’existe que si son drapeau et son hôte allowlisté sont posés. La localisation de l’hébergeur n’est publiée que si LEGAL_HOSTING_COUNTRY est renseigné.';

export const LEGAL_DISCLAIMER = `${LEGAL_NO_COMPLIANCE} ${LANDING_FOOTER_NOTE} ${LEGAL_HUMAN_REVIEW}`;
