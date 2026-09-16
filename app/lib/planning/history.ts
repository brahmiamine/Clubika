import type { DataSource } from 'typeorm';
import type {
  EntrainementEntity,
  MatchAmicalEntity,
  MatchAuditLogEntity,
  MatchOfficialEntity,
  PlateauEntity,
} from '@/lib/db/schemas';
import type { Entrainement, Match, Plateau } from '@/types/match';
import { getCurrentClubId } from '@/lib/auth/club-context';
import type { PlanningEventLinkType } from './event-links';
import { createTeamLogoResolver } from './team-logos';
import { officialMatchOverrideFieldLabel } from './official-match-overrides';
import { parseEntrainementPayload, parseMatchPayload, parsePlateauPayload } from '@/lib/db/planning-payload-codecs';
import { auditActorLabel } from '@/lib/audit/catalog';

export interface PlanningHistoryItem {
  id: number;
  entityType: string;
  entityId: string;
  action: string;
  title: string;
  actor: string;
  createdAt: Date;
  /** Libellé de l'événement lié (ex. "Afp 18 Seniors 1 – CA de Paris 14"), null si non résolu. */
  eventLabel: string | null;
  /** Type de l'événement lié (pour le lien vers l'espace événement), null si non résolu. */
  eventType: PlanningEventLinkType | null;
  /** Date de l'événement lié, null si non résolu. */
  eventDate: string | null;
  /** Équipes de la rencontre liée + logos, pour l'affichage « logo + nom ». */
  localTeam?: string;
  awayTeam?: string;
  localTeamLogo?: string;
  awayTeamLogo?: string;
  /** Résumé lisible de la différence entre la source officielle et la correction admin. */
  sourceOverrideSummary: string | null;
}

const ACTION_LABELS: Record<string, string> = {
  create: 'Création',
  update: 'Modification',
  delete: 'Suppression',
  attendance: 'Présence enregistrée',
  'auto-assign': 'Affectation automatique',
  publish: 'Publication',
  draft: 'Passage en brouillon',
  cancel: 'Annulation',
  reopen: 'Réouverture',
  'manual-reminder': 'Relance manuelle',
  respond: 'Réponse enregistrée',
};

const ENTITY_LABELS: Record<string, string> = {
  MatchOfficial: 'Match officiel',
  MatchAmical: 'Match amical',
  Entrainement: 'Entraînement',
  Plateau: 'Plateau',
  MatchExtra: 'Affectations du match',
  PlanningAttendance: 'Présence',
  PlanningAssignment: 'Affectation',
  PlanningPublication: 'Publication',
  PlanningReminder: 'Relance',
  PlanningCollaboration: 'Collaboration',
  PlanningResource: 'Ressource',
  PlanningTransport: 'Transport',
  PlanningReport: 'Rapport',
  PlanningProductivity: 'Productivité',
  AssignmentSwap: 'Échange d’affectation',
  ChatChannel: 'Discussion',
};

const ENTITY_TO_EVENT_TYPE: Record<string, PlanningEventLinkType> = {
  MatchOfficial: 'officiel',
  MatchAmical: 'amical',
  Entrainement: 'entrainement',
  Plateau: 'plateau',
};

interface EventRef {
  eventType: PlanningEventLinkType;
  eventId: string;
}

interface ResolvedEvent {
  label: string;
  eventType: PlanningEventLinkType;
  date: string | null;
  localTeam?: string;
  awayTeam?: string;
  localTeamLogo?: string;
  awayTeamLogo?: string;
}

function matchLabel(match: Match): string | null {
  if (match.localTeam && match.awayTeam) return `${match.localTeam} – ${match.awayTeam}`;
  if (match.localTeam || match.awayTeam) return match.localTeam || match.awayTeam;
  return null;
}

function simpleLabel(event: Entrainement | Plateau): string {
  if (event.type === 'entrainement') {
    return event.categorie ? `Entraînement ${event.categorie}` : 'Entraînement';
  }
  return event.categories?.length ? `Plateau ${event.categories.join(', ')}` : 'Plateau';
}

function extractEventRef(entry: MatchAuditLogEntity): EventRef | null {
  const directType = ENTITY_TO_EVENT_TYPE[entry.entityType];
  if (directType) {
    return { eventType: directType, eventId: entry.entityId };
  }
  // Formats composites : "eventType:eventId" (publication) ou "eventType:eventId:role"
  // (affectation automatique, relance).
  const [typePart, idPart] = entry.entityId.split(':');
  if (idPart && typePart && ['officiel', 'amical', 'entrainement', 'plateau'].includes(typePart)) {
    return { eventType: typePart as PlanningEventLinkType, eventId: idPart };
  }
  // MatchExtra : l'entityId est l'identifiant du match, sans indication de type.
  if (entry.entityType === 'MatchExtra') {
    return { eventType: 'officiel', eventId: entry.entityId };
  }
  return null;
}

async function buildEventMap(db: DataSource): Promise<Map<string, ResolvedEvent>> {
  const clubId = getCurrentClubId();
  const map = new Map<string, ResolvedEvent>();
  try {
    const [officialRows, friendlyRows, trainingRows, plateauRows] = await Promise.all([
      db.getRepository<MatchOfficialEntity>('MatchOfficial').findBy({ clubId }),
      db.getRepository<MatchAmicalEntity>('MatchAmical').findBy({ clubId }),
      db.getRepository<EntrainementEntity>('Entrainement').findBy({ clubId }),
      db.getRepository<PlateauEntity>('Plateau').findBy({ clubId }),
    ]);
    for (const row of officialRows) {
      const match = parseMatchPayload(row.payload, 'MatchOfficial', { id: row.id, type: 'officiel' });
      const label = matchLabel(match);
      if (row.id && label) {
        map.set(row.id, {
          label,
          eventType: 'officiel',
          date: match.date ?? null,
          localTeam: match.localTeam || undefined,
          awayTeam: match.awayTeam || undefined,
          localTeamLogo: match.localTeamLogo || undefined,
          awayTeamLogo: match.awayTeamLogo || undefined,
        });
      }
    }
    for (const row of friendlyRows) {
      const match = parseMatchPayload(row.payload, 'MatchAmical', { id: row.id, type: 'amical' });
      const label = matchLabel(match);
      if (row.id && label) {
        map.set(row.id, {
          label,
          eventType: 'amical',
          date: match.date ?? null,
          localTeam: match.localTeam || undefined,
          awayTeam: match.awayTeam || undefined,
          localTeamLogo: match.localTeamLogo || undefined,
          awayTeamLogo: match.awayTeamLogo || undefined,
        });
      }
    }
    for (const row of trainingRows) {
      const event = parseEntrainementPayload(row.payload, row.id);
      if (row.id) map.set(row.id, { label: simpleLabel(event), eventType: 'entrainement', date: event.date ?? null });
    }
    for (const row of plateauRows) {
      const event = parsePlateauPayload(row.payload, row.id);
      if (row.id) map.set(row.id, { label: simpleLabel(event), eventType: 'plateau', date: event.date ?? null });
    }
  } catch {
    // En cas d'indisponibilité, l'historique reste affiché sans libellés d'événements.
  }
  return map;
}

interface SourceOverrideAuditState {
  active: boolean;
  changedFields: string[];
}

function sourceOverrideAuditState(payload: Record<string, unknown> | null): SourceOverrideAuditState | null {
  const value = payload?.sourceOverride;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    active: record.active === true,
    changedFields: Array.isArray(record.changedFields)
      ? record.changedFields.filter((field): field is string => typeof field === 'string')
      : [],
  };
}

function sourceOverrideSummary(entry: MatchAuditLogEntity): string | null {
  if (entry.entityType !== 'MatchOfficial') return null;
  const before = sourceOverrideAuditState(entry.before);
  const after = sourceOverrideAuditState(entry.after);
  if (after?.active) {
    const labels = after.changedFields.map(officialMatchOverrideFieldLabel);
    return labels.length
      ? `Correction admin : ${labels.join(', ')}`
      : 'Correction admin active';
  }
  if (before?.active && after && !after.active) return 'Retour aux données source';
  return null;
}

export function humanizeAuditEntry(entry: MatchAuditLogEntity, eventMap?: Map<string, ResolvedEvent>): PlanningHistoryItem {
  const action = ACTION_LABELS[entry.action] ?? entry.action;
  const entity = ENTITY_LABELS[entry.entityType] ?? entry.entityType;
  const actor = auditActorLabel(entry.userId);

  let event: ResolvedEvent | undefined;
  const ref = extractEventRef(entry);
  if (ref && eventMap) {
    event = eventMap.get(ref.eventId);
  }

  const title = event ? `${action} · ${entity} — ${event.label}` : `${action} · ${entity}`;
  return {
    id: entry.id,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    title,
    actor,
    createdAt: entry.createdAt,
    eventLabel: event?.label ?? null,
    eventType: event?.eventType ?? ref?.eventType ?? null,
    eventDate: event?.date ?? null,
    localTeam: event?.localTeam,
    awayTeam: event?.awayTeam,
    localTeamLogo: event?.localTeamLogo,
    awayTeamLogo: event?.awayTeamLogo,
    sourceOverrideSummary: sourceOverrideSummary(entry),
  };
}

export async function buildReadableHistory(db: DataSource, limit = 100): Promise<PlanningHistoryItem[]> {
  // Isolation tenant : l'historique lisible est borné au club courant (issue #126).
  const clubId = getCurrentClubId();
  const rows = await db.getRepository<MatchAuditLogEntity>('MatchAuditLog').find({
    where: { clubId },
    order: { createdAt: 'DESC' },
    take: Math.max(1, Math.min(limit, 500)),
  });
  const eventMap = await buildEventMap(db);

  // Résout les logos des équipes (logos du match → logo du club → liste des clubs connus)
  // pour chaque rencontre référencée dans l'historique.
  try {
    const resolveTeamLogos = await createTeamLogoResolver(db, getCurrentClubId());
    for (const event of eventMap.values()) {
      if (!event.localTeam && !event.awayTeam) continue;
      const resolved = resolveTeamLogos({
        localTeam: event.localTeam ?? '',
        awayTeam: event.awayTeam ?? '',
        localTeamLogo: event.localTeamLogo,
        awayTeamLogo: event.awayTeamLogo,
      } as Match);
      event.localTeamLogo = resolved.localTeamLogo;
      event.awayTeamLogo = resolved.awayTeamLogo;
    }
  } catch {
    // Historique affiché sans logos si la résolution échoue.
  }

  return rows.map((row) => humanizeAuditEntry(row, eventMap));
}
