import type { DataSource } from 'typeorm';
import type { ChatMessageEntity, NotificationEntity, UserEntity } from '@/lib/db/schemas';
import { PRIVACY_CATALOG_VERSION } from './catalog';

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'token', 'tokenhash', 'tokenHash', 'secret', 'password', 'passwordHash',
  'icalToken', 'auth', 'p256dh', 'endpoint', 'signedUrl',
]);

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key) || /token|secret|password|hash/i.test(key)) continue;
    out[key] = stripSecrets(nested);
  }
  return out;
}

function accountDto(user: UserEntity) {
  return {
    id: user.id,
    clubId: user.clubId,
    email: user.email,
    nom: user.nom,
    telephone: user.telephone,
    accessRole: user.accessRole,
    planningFunctions: user.planningFunctions,
    active: user.active,
    notifyChannel: user.notifyChannel,
    createdAt: user.createdAt,
    processingRestrictedAt: user.processingRestrictedAt ?? null,
    processingOpposedAt: user.processingOpposedAt ?? null,
  };
}

/**
 * Export d’accès / portabilité : données du demandeur uniquement.
 * Pas de secrets, pas d’identifiants de session, pas de données d’autrui.
 */
export async function buildSubjectExport(db: DataSource, user: UserEntity): Promise<{
  schemaVersion: typeof PRIVACY_CATALOG_VERSION;
  generatedAt: string;
  account: ReturnType<typeof accountDto>;
  records: unknown[];
  assignments: unknown[];
  notifications: unknown[];
  chatMessages: unknown[];
}> {
  const recordRows = await db.query(
    `SELECT id, kind, event_type AS eventType, event_id AS eventId, payload, created_at AS createdAt
     FROM planning_records
     WHERE club_id = ? AND owner_user_id = ?
     ORDER BY created_at DESC
     LIMIT 500`,
    [user.clubId, user.id],
  ) as Array<{ id: string; kind: string; eventType: string | null; eventId: string | null; payload: string; createdAt: Date }>;

  const assignments = await db.query(
    `SELECT event_type AS eventType, event_id AS eventId, role, state, updated_at AS updatedAt
     FROM planning_assignment_state
     WHERE club_id = ? AND person_id = ?
     LIMIT 500`,
    [user.clubId, user.id],
  ) as Array<{ eventType: string; eventId: string; role: string; state: string; updatedAt: Date }>;

  const notifications = await db.getRepository<NotificationEntity>('Notification').find({
    where: { userId: user.id },
    order: { createdAt: 'DESC' },
    take: 200,
  });

  const chatMessages = await db.getRepository<ChatMessageEntity>('ChatMessage').find({
    where: { senderUserId: user.id },
    order: { createdAt: 'DESC' },
    take: 200,
  });

  return {
    schemaVersion: PRIVACY_CATALOG_VERSION,
    generatedAt: new Date().toISOString(),
    account: accountDto(user),
    records: recordRows.map((row) => {
      let payload: unknown = {};
      try { payload = JSON.parse(String(row.payload ?? '{}')); } catch { payload = {}; }
      return {
        id: row.id,
        kind: row.kind,
        eventType: row.eventType,
        eventId: row.eventId,
        createdAt: row.createdAt,
        payload: stripSecrets(payload),
      };
    }),
    assignments: assignments.map((row) => ({
      eventType: row.eventType,
      eventId: row.eventId,
      role: row.role,
      updatedAt: row.updatedAt,
      // `state` peut contenir un nom dénormalisé : on ne conserve que des clés techniques.
      status: (() => {
        try {
          const parsed = JSON.parse(String(row.state ?? '{}')) as Record<string, unknown>;
          return typeof parsed.status === 'string' ? parsed.status : null;
        } catch {
          return null;
        }
      })(),
    })),
    notifications: notifications.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      createdAt: item.createdAt,
      eventType: item.eventType,
      eventId: item.eventId,
    })),
    chatMessages: chatMessages.map((item) => ({
      id: item.id,
      roomId: item.roomId,
      createdAt: item.createdAt,
      content: item.deletedAt ? null : item.content,
      hasAttachment: Boolean(item.attachmentType),
    })),
  };
}

export function subjectExportToHtml(payload: Awaited<ReturnType<typeof buildSubjectExport>>): string {
  const account = payload.account;
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Export de données</title></head><body>
<h1>Export de vos données</h1>
<p>Généré le ${payload.generatedAt} — catalogue v${payload.schemaVersion}</p>
<h2>Compte</h2>
<ul>
<li>Identifiant technique : ${account.id}</li>
<li>Club : ${account.clubId}</li>
<li>Email : ${account.email}</li>
<li>Nom affiché : ${account.nom}</li>
<li>Téléphone : ${account.telephone ?? '—'}</li>
<li>Rôle : ${account.accessRole}</li>
</ul>
<p>${payload.records.length} enregistrement(s) de planning vous appartenant, ${payload.assignments.length} affectation(s), ${payload.notifications.length} notification(s), ${payload.chatMessages.length} message(s) dont vous êtes l’auteur.</p>
<p>Ce fichier ne contient pas les secrets, jetons, sessions ni les données d’autres personnes.</p>
</body></html>`;
}

export function exportContainsForbiddenNeedles(payload: unknown, needles: readonly string[]): boolean {
  const blob = JSON.stringify(payload ?? null).toLowerCase();
  return needles.some((needle) => blob.includes(needle.toLowerCase()));
}
