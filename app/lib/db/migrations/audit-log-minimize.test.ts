import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../index';
import { isDbAvailable } from '../test-utils';
import { MatchAuditLogEntity } from '../schemas';
import { sanitizeHistoricalAuditLogs } from './audit-log-minimize';
import { auditBlobContainsNeedle } from '@/lib/audit/minimize';

const dbAvailable = await isDbAvailable();

const SENTINEL_EMAIL = 'sentinel.hist@example.test';
const SENTINEL_NAME = 'Historique Sentinel';
const SENTINEL_TEXT = 'Ancien commentaire d’audit';

describe.skipIf(!dbAvailable)('migration 0025 — assainir_journaux_audit (issue #20)', () => {
  const entityId = `test-audit-minimize-${Date.now()}`;

  afterEach(async () => {
    const db = await getDb();
    await db.getRepository('MatchAuditLog').delete({ entityId });
  });

  it('inventorie en dry-run puis purge les payloads et acteurs nominatifs, de façon idempotente', async () => {
    const db = await getDb();
    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    await repo.save({
      clubId: 'club-min',
      entityType: 'PlanningCollaboration',
      entityId,
      action: 'report',
      userId: 8,
      userEmail: SENTINEL_EMAIL,
      userNom: SENTINEL_NAME,
      before: { text: SENTINEL_TEXT, nom: SENTINEL_NAME },
      after: { category: 'other', text: SENTINEL_TEXT, authorUserId: 8, confirmed: true },
    });

    const inventory = await sanitizeHistoricalAuditLogs(db, { dryRun: true, entityId });
    expect(inventory.scanned).toBe(1);
    expect(inventory.mutated).toBe(1);
    expect(inventory.actorCleared).toBe(1);
    expect(inventory.payloadRedacted).toBe(1);

    const stillDirty = await repo.findOneByOrFail({ entityId });
    expect(stillDirty.userEmail).toBe(SENTINEL_EMAIL);
    expect(stillDirty.userNom).toBe(SENTINEL_NAME);
    expect(auditBlobContainsNeedle(stillDirty.after, [SENTINEL_TEXT])).toBe(true);

    const applied = await sanitizeHistoricalAuditLogs(db, { dryRun: false, entityId });
    expect(applied.mutated).toBe(1);

    const cleaned = await repo.findOneByOrFail({ entityId });
    expect(cleaned.userEmail).toBeNull();
    expect(cleaned.userNom).toBeNull();
    expect(cleaned.after).toEqual({ category: 'other', authorUserId: 8, confirmed: true });
    expect(cleaned.before).toBeNull();
    expect(auditBlobContainsNeedle(cleaned, [SENTINEL_EMAIL, SENTINEL_NAME, SENTINEL_TEXT])).toBe(false);

    const second = await sanitizeHistoricalAuditLogs(db, { dryRun: false, entityId });
    expect(second.mutated).toBe(0);
    expect(second.actorCleared).toBe(0);
    expect(second.payloadRedacted).toBe(0);
  });

  it('restaure une copie synthétique après application (stratégie de retour arrière)', async () => {
    const db = await getDb();
    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    const original = await repo.save({
      clubId: 'club-min',
      entityType: 'MatchExtra',
      entityId,
      action: 'update',
      userId: 1,
      userEmail: SENTINEL_EMAIL,
      userNom: SENTINEL_NAME,
      before: { confirmed: false, note: SENTINEL_TEXT },
      after: { confirmed: true, note: SENTINEL_TEXT },
    });
    const snapshot = {
      userEmail: original.userEmail,
      userNom: original.userNom,
      before: original.before,
      after: original.after,
    };

    await sanitizeHistoricalAuditLogs(db, { dryRun: false, entityId });
    const mutated = await repo.findOneByOrFail({ entityId });
    expect(mutated.userEmail).toBeNull();
    expect(mutated.after).toEqual({ confirmed: true });

    mutated.userEmail = snapshot.userEmail;
    mutated.userNom = snapshot.userNom;
    mutated.before = snapshot.before;
    mutated.after = snapshot.after;
    await repo.save(mutated);

    const restored = await repo.findOneByOrFail({ entityId });
    expect(restored.userEmail).toBe(SENTINEL_EMAIL);
    expect(restored.after).toEqual({ confirmed: true, note: SENTINEL_TEXT });
  });

  it('est journalisée après init', async () => {
    const db = await getDb();
    const journal = await db.query(
      "SELECT name FROM schema_migrations WHERE version = '0025'",
    );
    expect(journal[0]?.name).toBe('assainir_journaux_audit');
  });
});
