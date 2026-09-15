import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSportCoricoSyncEnabled,
  isSportCoricoSyncEnabled,
  SPORTCORICO_SYNC_DISABLED_MESSAGE,
  SportCoricoSyncDisabledError,
} from './sync-gate';

describe('SportCorico sync kill switch (issue #4)', () => {
  const previous = process.env.SPORTCORICO_SYNC_ENABLED;

  afterEach(() => {
    if (previous === undefined) delete process.env.SPORTCORICO_SYNC_ENABLED;
    else process.env.SPORTCORICO_SYNC_ENABLED = previous;
  });

  it('est fermé par défaut et n’accepte que true', () => {
    delete process.env.SPORTCORICO_SYNC_ENABLED;
    expect(isSportCoricoSyncEnabled()).toBe(false);

    process.env.SPORTCORICO_SYNC_ENABLED = '';
    expect(isSportCoricoSyncEnabled()).toBe(false);

    process.env.SPORTCORICO_SYNC_ENABLED = '1';
    expect(isSportCoricoSyncEnabled()).toBe(false);

    process.env.SPORTCORICO_SYNC_ENABLED = 'yes';
    expect(isSportCoricoSyncEnabled()).toBe(false);

    process.env.SPORTCORICO_SYNC_ENABLED = 'TRUE';
    expect(isSportCoricoSyncEnabled()).toBe(true);

    process.env.SPORTCORICO_SYNC_ENABLED = ' true ';
    expect(isSportCoricoSyncEnabled()).toBe(true);
  });

  it('refuse l’exécution avec un message sans secret ni détail interne', () => {
    delete process.env.SPORTCORICO_SYNC_ENABLED;
    expect(() => assertSportCoricoSyncEnabled()).toThrow(SportCoricoSyncDisabledError);
    expect(() => assertSportCoricoSyncEnabled()).toThrow(SPORTCORICO_SYNC_DISABLED_MESSAGE);
  });
});
