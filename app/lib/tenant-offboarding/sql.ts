import type { DataSource } from 'typeorm';

const MAX_ROUNDS = 80;

export async function tableExists(db: DataSource, tableName: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [tableName],
  ) as unknown[];
  return rows.length > 0;
}

export async function countQuery(db: DataSource, sql: string, params: unknown[]): Promise<number> {
  const rows = await db.query(sql, params) as Array<{ n?: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

function affectedRows(result: unknown): number {
  const head = Array.isArray(result) ? result[0] : result;
  return Number((head as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

export async function deleteBatches(
  db: DataSource,
  deleteSql: string,
  params: unknown[],
  batchSize: number,
): Promise<number> {
  let deleted = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = await db.query(deleteSql, [...params, batchSize]);
    const n = affectedRows(result);
    deleted += n;
    if (n < batchSize) break;
  }
  return deleted;
}

export async function deleteBySelect(
  db: DataSource,
  options: {
    selectSql: string;
    selectParams: unknown[];
    deleteSql: (ids: string[]) => { sql: string; params: unknown[] };
    batchSize: number;
    idKey?: string;
  },
): Promise<number> {
  let deleted = 0;
  const key = options.idKey ?? 'id';
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const rows = await db.query(options.selectSql, [...options.selectParams, options.batchSize]) as Array<Record<string, unknown>>;
    if (rows.length === 0) break;
    const ids = rows.map((row) => String(row[key]));
    const { sql, params } = options.deleteSql(ids);
    const result = await db.query(sql, params);
    deleted += Math.max(affectedRows(result), ids.length);
    if (rows.length < options.batchSize) break;
  }
  return deleted;
}
