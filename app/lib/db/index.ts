import { DataSource } from 'typeorm';
import { getDataSource } from './data-source';
import { ensureDbSchemaForAvailability, ensureJsonDataMigrated } from './json-migrator';
import { ensureAdminBootstrap } from './user-bootstrap';
import { ensurePlatformAdminBootstrap } from './platform-bootstrap';

declare global {
  var __clubikaDbBootstrapped: boolean | undefined;
  var __clubikaDbBootstrapPromise: Promise<void> | undefined;
}

export async function getDb(): Promise<DataSource> {
  const dataSource = await getDataSource();

  if (globalThis.__clubikaDbBootstrapped) {
    return dataSource;
  }

  if (!globalThis.__clubikaDbBootstrapPromise) {
    globalThis.__clubikaDbBootstrapPromise = (async () => {
      await ensureDbSchemaForAvailability(dataSource);
      await ensureJsonDataMigrated(dataSource);
      await ensureAdminBootstrap(dataSource);
      await ensurePlatformAdminBootstrap(dataSource);
      globalThis.__clubikaDbBootstrapped = true;
    })().finally(() => {
      globalThis.__clubikaDbBootstrapPromise = undefined;
    });
  }

  await globalThis.__clubikaDbBootstrapPromise;
  return dataSource;
}
