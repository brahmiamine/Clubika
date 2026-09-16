import { describe, it, expect, afterEach } from 'vitest';
import { isDbAvailable } from './test-utils';
import { getDb } from './index';
import { logAuditEntry } from './audit-log';
import { backfillAuditLogClubId } from './migrations/audit-log-tenant';
import { MatchAuditLogEntity } from './schemas';
import type { SessionUser } from '@/lib/auth/session';
import { auditBlobContainsNeedle } from '@/lib/audit/minimize';

const dbAvailable = await isDbAvailable();

function testUser(clubId: string, id = 1): SessionUser {
  return {
    id,
    clubId,
    email: `admin-${clubId}@example.com`,
    nom: 'Admin',
    accessRole: 'admin',
    planningFunctions: [],
    telephone: null,
    indisponibilites: null,
    active: true,
    notifyChannel: 'push',
  };
}

describe.skipIf(!dbAvailable)('logAuditEntry (integration)', () => {
  const entityId = `test-match-${Date.now()}`;

  afterEach(async () => {
    const db = await getDb();
    await db.getRepository('MatchAuditLog').delete({ entityId });
  });

  it('writes a row with the expected fields', async () => {
    const db = await getDb();

    await logAuditEntry(db, {
      user: testUser('afp'),
      entityType: 'MatchExtra',
      entityId,
      action: 'update',
      before: { confirmed: false },
      after: { confirmed: true },
    });

    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    const rows = await repo.find({ where: { entityId } });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('update');
    expect(rows[0]?.userId).toBe(1);
    expect(rows[0]?.userEmail).toBeNull();
    expect(rows[0]?.userNom).toBeNull();
    expect(rows[0]?.after).toEqual({ confirmed: true });
  });

  it('stamps the tenant from the writing user (issue #126)', async () => {
    const db = await getDb();

    await logAuditEntry(db, {
      user: testUser('club-b', 2),
      entityType: 'MatchExtra',
      entityId,
      action: 'create',
      before: null,
      after: { confirmed: true },
    });

    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    const rows = await repo.find({ where: { entityId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clubId).toBe('club-b');
  });

  it('accepts a system write with an explicit clubId (issue #126)', async () => {
    const db = await getDb();
    await expect(
      logAuditEntry(db, {
        user: null,
        clubId: 'afp',
        entityType: 'Entrainement',
        entityId,
        action: 'create',
        before: null,
        after: { date: '20/01/2026' },
      }),
    ).resolves.not.toThrow();

    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    const rows = await repo.find({ where: { entityId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clubId).toBe('afp');
    expect(rows[0]?.userId).toBeNull();
  });

  it('rejects a write whose tenant cannot be determined (issue #126)', async () => {
    const db = await getDb();
    await expect(
      logAuditEntry(db, {
        user: null,
        entityType: 'Entrainement',
        entityId,
        action: 'create',
        before: null,
        after: { date: '20/01/2026' },
      }),
    ).rejects.toThrow(/Tenant indéterminé/);

    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    expect(await repo.find({ where: { entityId } })).toHaveLength(0);
  });

  it('isolates entries per club even for a shared entityId (issue #126)', async () => {
    const db = await getDb();

    await logAuditEntry(db, {
      user: testUser('club-a', 3),
      entityType: 'MatchOfficial',
      entityId,
      action: 'update',
      before: null,
      after: { confirmed: true },
    });
    await logAuditEntry(db, {
      user: testUser('club-b', 4),
      entityType: 'MatchOfficial',
      entityId,
      action: 'update',
      before: null,
      after: { confirmed: false },
    });

    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    const rowsA = await repo.find({ where: { entityId, clubId: 'club-a' } });
    const rowsB = await repo.find({ where: { entityId, clubId: 'club-b' } });

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.after).toEqual({ confirmed: true });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.after).toEqual({ confirmed: false });
  });

  it('n’écrit jamais les sentinelles nominatives en base (issue #20)', async () => {
    const db = await getDb();
    const sentinels = {
      nom: 'Sentinel Write',
      email: 'sentinel.write@example.test',
      telephone: '0699887766',
      text: 'Texte de rapport sentinelle',
      fileName: 'secret-write.pdf',
      token: 'tok_write_secret',
    };
    await logAuditEntry(db, {
      user: testUser('afp'),
      entityType: 'PlanningCollaboration',
      entityId,
      action: 'report',
      before: sentinels,
      after: { ...sentinels, category: 'other', authorUserId: 1, confirmed: true },
    });

    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    const row = await repo.findOneByOrFail({ entityId });
    expect(row.userEmail).toBeNull();
    expect(row.userNom).toBeNull();
    expect(row.userId).toBe(1);
    expect(row.after).toEqual({ category: 'other', authorUserId: 1, confirmed: true });
    expect(row.before).toBeNull();
    expect(auditBlobContainsNeedle(row, Object.values(sentinels))).toBe(false);
    expect(auditBlobContainsNeedle({ email: row.userEmail, nom: row.userNom }, [
      'admin-afp@example.com',
      'Admin',
    ])).toBe(false);
  });
});

describe.skipIf(!dbAvailable)('migration 0009 — audit_log_tenant_scoped (integration)', () => {
  const suffix = Date.now().toString(36);
  const auditTable = `test_audit_${suffix}`;
  const usersTable = `test_users_${suffix}`;

  afterEach(async () => {
    const db = await getDb();
    await db.query(`DROP TABLE IF EXISTS ${auditTable}`);
    await db.query(`DROP TABLE IF EXISTS ${usersTable}`);
  });

  async function createScratchTables() {
    const db = await getDb();
    await db.query(
      `CREATE TABLE ${auditTable} (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        clubId VARCHAR(255) NULL,
        userId INT NULL,
        entityId VARCHAR(191) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await db.query(
      `CREATE TABLE ${usersTable} (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        clubId VARCHAR(255) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    return db;
  }

  it('backfills clubId from the author and falls back for orphans', async () => {
    const db = await createScratchTables();
    await db.query(`INSERT INTO ${usersTable} (id, clubId) VALUES (1, 'club-a'), (2, 'club-b')`);
    await db.query(
      `INSERT INTO ${auditTable} (clubId, userId, entityId) VALUES
        (NULL, 1, 'e1'),
        (NULL, 2, 'e2'),
        (NULL, 999, 'e3'),
        ('', 1, 'e4'),
        ('club-z', 2, 'e5')`,
    );

    const result = await backfillAuditLogClubId(db, { auditTable, usersTable });

    expect(result).not.toBeNull();
    // e1, e2 et e4 (vide) sont remplis par jointure ; e3 (auteur orphelin) bascule sur le club par défaut ;
    // e5 est déjà renseigné et ne bouge pas.
    expect(result?.joined).toBe(3);
    expect(result?.fallback).toBe(1);

    const rows = await db.query(`SELECT entityId, clubId FROM ${auditTable} ORDER BY entityId`);
    const byEntity = new Map(rows.map((r: { entityId: string; clubId: string }) => [r.entityId, r.clubId]));
    expect(byEntity.get('e1')).toBe('club-a');
    expect(byEntity.get('e2')).toBe('club-b');
    expect(byEntity.get('e3')).toBe(process.env.APP_CLUB_ID || 'afp');
    expect(byEntity.get('e4')).toBe('club-a');
    expect(byEntity.get('e5')).toBe('club-z');
  });

  it('is idempotent on a second run', async () => {
    const db = await createScratchTables();
    await db.query(`INSERT INTO ${usersTable} (id, clubId) VALUES (1, 'club-a')`);
    await db.query(`INSERT INTO ${auditTable} (clubId, userId, entityId) VALUES (NULL, 1, 'e1')`);

    await backfillAuditLogClubId(db, { auditTable, usersTable });
    const second = await backfillAuditLogClubId(db, { auditTable, usersTable });

    expect(second?.joined).toBe(0);
    expect(second?.fallback).toBe(0);
  });

  it('ignores an absent table (fresh install path)', async () => {
    const db = await getDb();
    const result = await backfillAuditLogClubId(db, {
      auditTable: `absent_${suffix}`,
      usersTable,
    });
    expect(result).toBeNull();
  });

  it('is journaled and the real column is NOT NULL after init', async () => {
    const db = await getDb();
    const journal = await db.query(
      "SELECT name FROM schema_migrations WHERE version = '0009'",
    );
    expect(journal[0]?.name).toBe('audit_log_tenant_scoped');

    const columns = await db.query(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'match_audit_log' AND COLUMN_NAME = 'clubId'`,
    );
    expect(columns[0]?.IS_NULLABLE).toBe('NO');

    const indices = await db.query(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'match_audit_log'
       GROUP BY INDEX_NAME`,
    );
    const entityIndex = indices.find((r: { INDEX_NAME: string }) => r.INDEX_NAME === 'idx_match_audit_log_entity');
    expect(String(entityIndex?.cols).split(',').slice(0, 2)).toEqual(['clubId', 'entityType']);
  });
});
