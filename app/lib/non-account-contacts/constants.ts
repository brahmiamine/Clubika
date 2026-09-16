export const PRIVACY_NO_LEGAL_PROMISE =
  'Les délais et textes affichés ici sont des paramètres produit configurés par le club. '
  + 'Ils ne constituent pas un avis juridique ni une obligation légale calculée par l’application.';

export const CONTACT_CATEGORIES = ['officiel', 'encadrant', 'accompagnateur'] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

export const CONTACT_PROVENANCES = [
  'responsable_club',
  'liste_competition',
  'declaration_concernee',
  'import_csv',
] as const;
export type ContactProvenance = (typeof CONTACT_PROVENANCES)[number];

export const CONTACT_PROVENANCE_LABELS: Record<ContactProvenance, string> = {
  responsable_club: 'Saisie par un responsable du club',
  liste_competition: 'Liste de compétition',
  declaration_concernee: 'Déclaration de la personne concernée',
  import_csv: 'Import CSV',
};

export const CONTACT_PURPOSES = ['organisation_planning', 'contact_operationnel'] as const;
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];

export const CONTACT_PURPOSE_LABELS: Record<ContactPurpose, string> = {
  organisation_planning: 'Organisation du planning',
  contact_operationnel: 'Contact opérationnel',
};

export const NOTICE_CHANNELS = ['invitation', 'in_person', 'email', 'postal', 'not_sent'] as const;
export type NoticeChannel = (typeof NOTICE_CHANNELS)[number];

export const NOTICE_RESULTS = ['pending', 'sent', 'failed', 'not_applicable'] as const;
export type NoticeResult = (typeof NOTICE_RESULTS)[number];

export const CONTACT_STATUSES = ['active', 'unused', 'refused', 'orphan'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  active: 'Active',
  unused: 'Jamais utilisée',
  refused: 'Refus / opposition',
  orphan: 'Orpheline',
};

export const RIGHTS_TYPES = ['access', 'rectification', 'opposition', 'erasure'] as const;
export type RightsType = (typeof RIGHTS_TYPES)[number];

export const RIGHTS_TYPE_LABELS: Record<RightsType, string> = {
  access: 'Accès',
  rectification: 'Rectification',
  opposition: 'Opposition',
  erasure: 'Effacement',
};

export const RIGHTS_STATUSES = ['received', 'processed', 'rejected'] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

export const CATEGORY_PLANNING_FUNCTION: Record<ContactCategory, 'arbitre_club' | 'encadrant' | 'accompagnateur'> = {
  officiel: 'arbitre_club',
  encadrant: 'encadrant',
  accompagnateur: 'accompagnateur',
};

export const PUBLIC_RIGHTS_RECEIVED =
  'Demande enregistrée. Un administrateur du club la traitera. Ce canal ne confirme pas l’identité et ne calcule aucun délai légal.';

export const FUNCTIONAL_LABEL_PREFIX = 'fiche-';

export class ContactLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ContactLifecycleError';
  }
}
