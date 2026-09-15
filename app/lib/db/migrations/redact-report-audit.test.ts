import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { redactHistoricalReportAudits } from './redact-report-audit';

const dbAvailable = await isDbAvailable();
const SECRET = 'UNIQUE_REPORT_BODY_DO_NOT_COPY';

describe('migration 0025 — table absente', () => {
  it('ignore le backfill lorsque match_audit_log n’existe pas encore', async () => {
    const query = async (sql: string) => {
      if (sql.includes('information_schema.tables')) return [];
      throw new Error(`requête inattendue: ${sql}`);
    };
    const result = await redactHistoricalReportAudits({ query } as never, { tableName: 'absent_audit' });
    expect(result).toEqual({ scanned: 0, updated: 0 });
  });
});

describe.skipIf(!dbAvailable)('migration 0025 — redactHistoricalReportAudits (issue #8)', () => {
  const suffix = Date.now().toString(36);
  const auditTable = `test_report_audit_${suffix}`;
  const recordsTable = `test_report_records_${suffix}`;

  afterEach(async () => {
    const db = await getDb();
    await db.query(`DROP TABLE IF EXISTS ${auditTable}`);
    await db.query(`DROP TABLE IF EXISTS ${recordsTable}`);
  });

  async function createScratch() {
    const db = await getDb();
    await db.query(
      `CREATE TABLE ${auditTable} (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        entityType VARCHAR(64) NOT NULL,
        entityId VARCHAR(191) NOT NULL,
        action VARCHAR(32) NOT NULL,
        \`before\` LONGTEXT NULL,
        \`after\` LONGTEXT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await db.query(
      `CREATE TABLE ${recordsTable} (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        event_type VARCHAR(32) NULL,
        event_id VARCHAR(191) NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    return db;
  }

  it('expurge le texte en dry-run puis réellement, et se rejoue sans effet', async () => {
    const db = await createScratch();
    const reportId = `post-event-report:${randomBytes(4).toString('hex')}`;
    await db.query(`INSERT INTO ${recordsTable} (id, event_type, event_id) VALUES (?, 'officiel', 'm1')`, [reportId]);
    await db.query(
      `INSERT INTO ${auditTable} (entityType, entityId, action, \`before\`, \`after\`) VALUES
        ('PlanningCollaboration', ?, 'report', NULL, ?),
        ('PlanningCollaboration', ?, 'create', NULL, ?)`,
      [
        reportId,
        JSON.stringify({
          category: 'incident',
          text: SECRET,
          authorName: 'Auteur Test',
          authorUserId: 1,
          authorRole: 'dirigeant',
        }),
        'other-id',
        JSON.stringify({ text: SECRET, label: 'tâche' }),
      ],
    );

    const dry = await redactHistoricalReportAudits(db, {
      dryRun: true,
      tableName: auditTable,
      recordsTable,
    });
    expect(dry.updated).toBe(1);
    const stillThere = await db.query(`SELECT \`after\` AS afterJson FROM ${auditTable} WHERE entityId = ?`, [reportId]);
    expect(String(stillThere[0]?.afterJson)).toContain(SECRET);

    const applied = await redactHistoricalReportAudits(db, { tableName: auditTable, recordsTable });
    expect(applied.updated).toBe(1);
    const rows = await db.query(`SELECT action, \`after\` AS afterJson FROM ${auditTable} ORDER BY id`);
    const reportRow = rows.find((row: { action: string }) => row.action === 'report');
    const otherRow = rows.find((row: { action: string }) => row.action === 'create');
    const after = typeof reportRow.afterJson === 'string' ? JSON.parse(reportRow.afterJson) : reportRow.afterJson;
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(after).not.toHaveProperty('text');
    expect(after).not.toHaveProperty('authorName');
    expect(after.category).toBe('incident');
    expect(after.reportId).toBe(reportId);
    expect(after.eventType).toBe('officiel');
    expect(after.eventId).toBe('m1');
    expect(after.redacted).toBe(true);
    expect(String(otherRow.afterJson)).toContain(SECRET);

    const second = await redactHistoricalReportAudits(db, { tableName: auditTable, recordsTable });
    expect(second.updated).toBe(0);
  });
});
