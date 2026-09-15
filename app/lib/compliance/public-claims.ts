/**
 * Copie publique et garde-fous d’allégations (issue #38).
 *
 * Toute phrase sécurité / confidentialité / chiffrement / RGPD / hébergement /
 * partage / prestataires destinée au public doit rester factuelle, limitée à un
 * comportement testé, et ne jamais réintroduire les formulations interdites.
 *
 * Les claims positifs plus larges (pièces jointes chiffrées, DTO public sans
 * identités, attestation RGPD, prestataires autorisés) restent masqués jusqu’à
 * la fermeture et la validation humaine des tickets #6, #12, #20, #24 et #30.
 */

export interface LandingFeature {
  num: string;
  title: string;
  copy: string;
}

export interface LandingRole {
  tag: string;
  name: string;
  copy: string;
}

export interface LandingSecurityItem {
  title: string;
  copy: string;
}

export interface LandingFaqItem {
  q: string;
  a: string;
}

export interface RetainedPublicClaim {
  id: string;
  surface: string;
  statement: string;
  proof: string;
  reviewOwner: string;
}

/** Surfaces lues par le test d’allowlist — UI, README, docs publics, metadata. */
export const PUBLIC_CLAIM_SURFACES = [
  'app/components/landing/LandingPage.tsx',
  'app/lib/compliance/public-claims.ts',
  'app/page.tsx',
  'app/lib/pwa/branding.ts',
  'app/manifest.ts',
  'README.md',
  'deploy/README.md',
] as const;

/**
 * Formulations absolues ou non démontrées. Les drapeaux `iu` sont appliqués
 * dans le test ; les motifs restent des sources pour que ce module reste
 * importable par le bundle client.
 */
export const FORBIDDEN_PUBLIC_CLAIM_PATTERNS: ReadonlyArray<{ id: string; source: string }> = [
  { id: '100-legal', source: String.raw`100\s*%\s*légal` },
  { id: 'conforme-rgpd', source: String.raw`conforme(?:\s+au)?\s+RGPD` },
  { id: 'conformite-rgpd', source: String.raw`conformit[eé](?:\s+au)?\s+RGPD` },
  { id: 'gdpr-compliant', source: String.raw`GDPR\s+compliant` },
  { id: 'entierement-securise', source: String.raw`entièrement\s+sécurisé` },
  { id: 'totalement-securise', source: String.raw`totalement\s+sécurisé` },
  { id: '100-secur', source: String.raw`100\s*%\s*sécur` },
  { id: '100-conforme', source: String.raw`100\s*%\s*conforme` },
  { id: 'aucune-donnee-personnelle', source: String.raw`aucune\s+donnée\s+personnelle` },
  { id: 'aucune-donnee-n-est', source: String.raw`aucune\s+donnée\s+n['’]est` },
  { id: 'le-tout-chiffre', source: String.raw`le\s+tout\s+chiffr` },
  { id: 'entierement-chiffre', source: String.raw`entièrement\s+chiffr` },
  { id: 'limitent-calendrier', source: String.raw`se\s+limitent\s+au\s+calendrier` },
  { id: 'limite-donnees-calendrier', source: String.raw`limité(?:es)?\s+aux\s+données\s+de\s+calendrier` },
];

export const LANDING_FEATURES: LandingFeature[] = [
  {
    num: '01',
    title: 'Planning unifié',
    copy: 'Matchs officiels, matchs amicaux, entraînements et plateaux. Vues carte, liste et calendrier, événements récurrents, duplication et modèles, avec un cycle clair brouillon → publié → modifié → annulé.',
  },
  {
    num: '02',
    title: 'Affectations & échanges',
    copy: "Affectation des arbitres, encadrants et accompagnateurs avec identité stable. Acceptation ou refus motivé, échanges entre utilisateurs validés par un administrateur, auto-affectation qui tient compte des indisponibilités, conflits et charge.",
  },
  {
    num: '03',
    title: 'Pilotage opérationnel',
    copy: "Dashboard administrateur avec alertes, charge, météo et historique. Suivi présent / excusé / absent / remplacé, statistiques de couverture et d'équité.",
  },
  {
    num: '04',
    title: 'Notifications',
    copy: "In-app et Web Push via la PWA. L'e-mail n'est envoyé que si un serveur SMTP est configuré. WhatsApp n'est jamais activé par défaut : il exige WHATSAPP_PROVIDER, un contrat prestataire et un opt-in utilisateur. Les autres canaux externes restent désactivés tant qu'ils ne sont pas explicitement activés.",
  },
];

export const LANDING_ROLES: LandingRole[] = [
  {
    tag: 'Écriture',
    name: 'Administrateur',
    copy: "Seul rôle d'écriture : planning, référentiels, utilisateurs, invitations, dashboard et configuration du club.",
  },
  {
    tag: 'Terrain',
    name: 'Arbitre',
    copy: 'Ses affectations publiées, ses disponibilités, ses préférences et ses échanges, en lecture seule.',
  },
  {
    tag: 'Terrain',
    name: 'Encadrant',
    copy: 'Suivi de ses événements, de ses disponibilités et des espaces événement auxquels il est affecté.',
  },
  {
    tag: 'Terrain',
    name: 'Accompagnateur',
    copy: 'Un espace dédié à ses propres affectations, sans accès aux données des autres membres.',
  },
];

export const LANDING_CHAT_FACTS: string[] = [
  'Conversations privées entre deux utilisateurs actifs du même club.',
  'Un chat attaché à chaque événement publié, lisible par tous les affectés.',
  'Canaux de groupe créés par un administrateur, avec liste de participants.',
  'Reprise après reconnexion, déduplication des messages, accusés ✓ envoyé / ✓✓ lu.',
];

export const LANDING_CHAT_INTRO =
  'Conversations privées, chat par événement visible de tous les affectés, canaux de groupe créés par un administrateur. Messages persistés, accusés de lecture, envoi de photos, GIF, vidéos et audio, isolés par club. Le texte des messages est chiffré en AES-256-GCM lorsque APP_ENCRYPTION_KEY est défini ; les pièces jointes ne le sont pas.';

export const LANDING_SECURITY_ITEMS: LandingSecurityItem[] = [
  {
    title: 'Chiffrement applicatif',
    copy: "Le texte des messages de chat et les mots de passe SMTP sont chiffrés en AES-256-GCM lorsque APP_ENCRYPTION_KEY est défini (obligatoire en production). Les pièces jointes, sauvegardes et autres champs ne sont pas couverts par ce mécanisme.",
  },
  {
    title: 'Liens de partage',
    copy: "Les liens publics expirent (1 à 90 jours) ; seul le SHA-256 du jeton est enregistré. Le calendrier public peut encore afficher les noms des personnes affectées. Les téléphones, identifiants internes, commentaires, rapports et journaux d'audit n'y figurent pas.",
  },
  {
    title: 'Isolation par club',
    copy: "Chaque enregistrement métier porte un clubId, avec un contrôle d'accès côté serveur à chaque lecture et écriture. Cela décrit le comportement testé du code, pas une attestation de conformité.",
  },
  {
    title: 'Export CSV administrateur',
    copy: "L'export CSV réservé aux administrateurs neutralise les cellules qui pourraient être interprétées comme des formules tableur. Ce n'est pas un export public.",
  },
];

export const LANDING_FAQ_ITEMS: LandingFaqItem[] = [
  {
    q: 'Clubika gère-t-il plusieurs clubs ?',
    a: "Oui. Chaque club dispose de ses propres données, réglages et administrateurs, isolés les uns des autres. Un compte plateforme distinct supervise l'ensemble des clubs.",
  },
  {
    q: "Quels rôles existent dans l'application ?",
    a: "Quatre rôles : administrateur (seul rôle d'écriture) puis arbitre, encadrant et accompagnateur, des rôles terrain en lecture seule sur leurs propres affectations.",
  },
  {
    q: "Comment fonctionnent les échanges d'affectations ?",
    a: "Un utilisateur propose un échange, la personne visée l'accepte, puis un administrateur valide le remplacement — avec revalidation des disponibilités et des conflits avant toute approbation.",
  },
  {
    q: 'Peut-on exporter ou partager le planning ?',
    a: "Oui : export CSV et PDF pour les administrateurs, abonnement iCal personnel, et liens publics temporaires de 1 à 90 jours. Un lien public peut encore afficher les noms des personnes affectées.",
  },
  {
    q: 'Quelles notifications reçoivent les utilisateurs ?',
    a: "In-app et Web Push via la PWA. L'e-mail dépend d'une configuration SMTP. WhatsApp n'est envoyé que si un prestataire explicite est activé et que l'utilisateur a consenti dans ses notifications. WhatsApp et les autres destinations externes restent désactivés tant qu'ils ne sont pas explicitement activés.",
  },
];

export const LANDING_FOOTER_NOTE =
  'Les descriptions de cette page reflètent le comportement observé de cette version du logiciel ; elles ne constituent pas une attestation juridique, de sécurité ou de conformité.';

/**
 * Claims conservés après le retrait des allégations non démontrées.
 * Chaque entrée pointe vers une preuve (test ou configuration) et un propriétaire
 * de revue. Ne pas élargir sans ticket fermé et revue humaine.
 */
export const RETAINED_PUBLIC_CLAIMS: RetainedPublicClaim[] = [
  {
    id: 'chat-text-aes-gcm',
    surface: 'landing-security + README',
    statement:
      'Texte des messages de chat et mots de passe SMTP chiffrés en AES-256-GCM si APP_ENCRYPTION_KEY est défini ; obligatoire en production.',
    proof: 'app/lib/crypto/secret-box.test.ts ; server.ts assertEncryptionConfiguredForProduction',
    reviewOwner: 'engineering',
  },
  {
    id: 'share-token-sha256',
    surface: 'landing-security + README',
    statement: 'Seul le SHA-256 du jeton de partage public est enregistré ; les liens expirent de 1 à 90 jours.',
    proof: 'app/lib/planning/public-share.test.ts',
    reviewOwner: 'engineering',
  },
  {
    id: 'share-dto-current',
    surface: 'landing-security + README',
    statement:
      'Le DTO public n’inclut pas téléphone, personId, commentaires, rapports ni audit ; il peut encore inclure les noms des personnes affectées.',
    proof: 'app/lib/planning/public-share.test.ts',
    reviewOwner: 'engineering — élargissement bloqué jusqu’à #6',
  },
  {
    id: 'csv-formula-injection',
    surface: 'landing-security + README',
    statement: 'Export CSV administrateur : cellules formules neutralisées.',
    proof: 'app/lib/planning/export.test.ts',
    reviewOwner: 'engineering',
  },
  {
    id: 'tenant-isolation',
    surface: 'landing-security',
    statement: 'Enregistrements métier isolés par clubId avec contrôle d’accès serveur.',
    proof: 'tests d’API multi-tenant (routes club / auth)',
    reviewOwner: 'engineering',
  },
  {
    id: 'whatsapp-off-default',
    surface: 'landing-faq + README',
    statement: 'WhatsApp désactivé en l’absence de configuration explicite.',
    proof: 'docs/whatsapp-activation.md ; tests notifications destinations ; issue #17',
    reviewOwner: 'engineering — activation prestataire encore soumise à #30',
  },
];
