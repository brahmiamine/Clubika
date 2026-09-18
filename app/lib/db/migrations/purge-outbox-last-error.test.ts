import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { purgeOutboxLastError } from './purge-outbox-last-error';

describe('purgeOutboxLastError (issue #31)', () => {
  it('counts without writing when MIGRATION_DRY_RUN=1', async () => {
    process.env.MIGRATION_DRY_RUN = '1';
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.tables')) return [{ c: 1 }];
      return [{ c: 3 }];
    });
    const db = { query } as unknown as DataSource;
    const result = await purgeOutboxLastError(db);
    expect(result).toEqual({ before: 3, after: 3 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
    delete process.env.MIGRATION_DRY_RUN;
  });

  it('nulls legacy last_error rows that are not classified JSON', async () => {
    delete process.env.MIGRATION_DRY_RUN;
    let lastErrorCountCalls = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('information_schema.tables')) return [{ c: 1 }];
      if (sql.trim().startsWith('UPDATE')) return { affectedRows: 2 };
      if (sql.includes('last_error')) {
        lastErrorCountCalls += 1;
        return [{ c: lastErrorCountCalls === 1 ? 2 : 0 }];
      }
      return [{ c: 0 }];
    });
    const db = { query } as unknown as DataSource;
    const result = await purgeOutboxLastError(db);
    expect(result).toEqual({ before: 2, after: 0 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(true);
  });
});
