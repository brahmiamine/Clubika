/**
 * Catalogue versionné des champs d'audit autorisés (issue #20).
 *
 * Toute écriture `before`/`after` est filtrée par ce catalogue : un champ absent
 * de la liste est omis, un champ dénylisté l'est même s'il figurait dans un
 * snapshot métier. Étendre le catalogue = incrémenter `AUDIT_CATALOG_VERSION`
 * et, si des lignes historiques doivent être réassainies, ajouter une migration.
 */

export const AUDIT_CATALOG_VERSION = 1 as const;

/** Libellé d'acteur pseudonymisé — jamais un nom, un e-mail ou un téléphone. */
export function auditActorLabel(userId: number | null | undefined): string {
  return userId == null ? 'Système' : `Utilisateur #${userId}`;
}

/**
 * Champs techniques autorisés, toutes actions confondues.
 *
 * Par famille d'événements (documentation du catalogue action par action) :
 * - MatchOfficial/MatchAmical/Entrainement/Plateau create|update|delete :
 *   id, date, time, durationMinutes, venue, confirmed, seriesId, type,
 *   planningStatus, révisions, sourceOverride.{active,changedFields}.
 * - MatchExtra create|update : confirmed, identifiants d'affectés, statuts.
 * - PlanningAttendance attendance : contacts.{personId,personType,status,attendanceStatus}.
 * - PlanningAssignment respond|auto-assign : contacts, personId, role, score, statuts.
 * - PlanningPublication publish|draft|cancel|reopen : planningStatus, horodatages,
 *   identifiants, compteurs de diff (sans titres d'événements).
 * - PlanningReminder manual-reminder : sent, personId, roles.
 * - PlanningCollaboration create|update|complete|delete|report :
 *   kind, category, authorUserId, assigneeUserId, completedByUserId, dueAt,
 *   mimeType, sizeBytes (jamais texte, nom de fichier, auteur nominatif).
 * - PlanningShare share|delete : expiresAt, scope.
 * - AssignmentSwap create|approve|reject|update : eventType, eventId, role, status,
 *   requester/target.userId.
 * - ChatChannel create|update|archive : clubId, archived (jamais le nom du salon).
 * - PlanningAvailability approve|reject : status (jamais le commentaire de revue).
 */
export const AUDIT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'clubid',
  'eventtype',
  'eventid',
  'matchid',
  'seriesid',
  'entityid',
  'role',
  'roles',
  'kind',
  'type',
  'persontype',
  'personid',
  'userid',
  'authoruserid',
  'assigneeuserid',
  'assigneepersontype',
  'assigneepersonid',
  'completedbyuserid',
  'createdbyuserid',
  'uploadedbyuserid',
  'publishedbyuserid',
  'cancelledbyuserid',
  'owneruserid',
  'officialoverrideupdatedbyuserid',
  'status',
  'confirmed',
  'cancelled',
  'active',
  'archived',
  'published',
  'planningstatus',
  'planningrevision',
  'revision',
  'category',
  'scope',
  'mimetype',
  'venue',
  'sourcestatus',
  'attendancestatus',
  'assignmentstatus',
  'publicationrequired',
  'date',
  'time',
  'createdat',
  'updatedat',
  'completedat',
  'dueat',
  'expiresat',
  'archivedat',
  'publishedat',
  'assignedat',
  'respondedat',
  'attendanceupdatedat',
  'lastreminderat',
  'cancelledat',
  'modifiedafterpublishat',
  'sourcelastseenat',
  'sourcemissingsince',
  'sourceidentityreconciledat',
  'officialoverridedetectedat',
  'officialoverrideupdatedat',
  'durationminutes',
  'sizebytes',
  'size',
  'score',
  'sent',
  'remindercount',
  'reminderssent',
  'sourcemissingobservations',
  'sourceidentityconfidence',
  'sourcematchid',
  'sourcematchids',
  'sourcemissingcancelled',
  'sourceoverride',
  'changedfields',
  'contacts',
  'contact',
  'assignments',
  'arbitretouche',
  'contactencadrants',
  'contactaccompagnateur',
  'encadrants',
  'extras',
  'waitlist',
  'promoted',
  'candidate',
  'selected',
  'requester',
  'target',
  'diff',
  'added',
  'modified',
  'removed',
  'unchanged',
  'changed',
  'current',
  'events',
  'removedevents',
  'participantids',
  'participantuserids',
]);

/**
 * Clés toujours exclues, y compris si un snapshot métier les présente.
 * Comparaison sur la clé normalisée (minuscule, sans `_` ni `-`).
 */
export const AUDIT_DENIED_KEYS: ReadonlySet<string> = new Set([
  'nom',
  'name',
  'prenom',
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'email',
  'useremail',
  'usernom',
  'mail',
  'telephone',
  'phone',
  'numero',
  'mobile',
  'text',
  'message',
  'comment',
  'description',
  'label',
  'note',
  'notes',
  'rawtext',
  'declinereason',
  'declinecomment',
  'reviewcomment',
  'cancellationreason',
  'reason',
  'filename',
  'content',
  'body',
  'html',
  'token',
  'tokenhash',
  'secret',
  'password',
  'passwordhash',
  'auth',
  'authsecret',
  'p256dh',
  'signedurl',
  'itinerarylink',
  'url',
  'authorname',
  'personname',
  'personnom',
  'eventtitle',
  'title',
  'localteam',
  'awayteam',
  'localteamlogo',
  'awayteamlogo',
  'stadium',
  'address',
  'lieu',
  'location',
  'competition',
  'categorie',
  'categories',
  'details',
  'staff',
  'source',
  'officialsourcesnapshot',
  'officialadminoverride',
  'officialoverrideupdatedbyuseremail',
  'horairerendezvous',
]);

const DENIED_KEY_FRAGMENT = /(email|telephone|phone|password|secret|token|comment|filename|rawtext|signedurl)/i;

export function normalizeAuditKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

export function isDeniedAuditKey(key: string): boolean {
  const normalized = normalizeAuditKey(key);
  return AUDIT_DENIED_KEYS.has(normalized) || DENIED_KEY_FRAGMENT.test(normalized);
}

export function isAllowedAuditKey(key: string): boolean {
  if (isDeniedAuditKey(key)) return false;
  return AUDIT_ALLOWED_KEYS.has(normalizeAuditKey(key));
}
