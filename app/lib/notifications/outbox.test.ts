import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { enqueueNotificationDelivery, markNotificationFailed } from './outbox';

function baseInput() {
  return {
    userId: 1,
    channel: 'push' as const,
    type: 'planning-published-added',
    title: 'Nouvelle affectation',
    message: 'Vous êtes affecté',
    eventType: 'amical',
    eventId: 'evt-1',
    urgency: 'normal' as const,
  };
}

describe('enqueueNotificationDelivery — idempotence (issue #276)', () => {
  it('insère une nouvelle ligne quand aucune clé d’idempotence n’est fournie', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ affectedRows: 1 }));
    const db = { query } as unknown as DataSource;

    const item = await enqueueNotificationDelivery(db, baseInput());

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('ON DUPLICATE KEY UPDATE id = id');
    expect(item.userId).toBe(1);
    expect(item.attempts).toBe(0);
  });

  it('relit la ligne existante par clé d’idempotence au lieu de renvoyer un identifiant fantôme', async () => {
    // Simule une collision d'idempotence : l'INSERT ... ON DUPLICATE KEY UPDATE ne crée
    // rien (id = id, no-op), puis le SELECT qui suit retrouve la ligne déjà présente,
    // écrite par une tentative antérieure — jamais celle générée par cet appel.
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.trim().startsWith('INSERT')) return { affectedRows: 0 };
      return [{
        id: 'existing-outbox-id',
        userId: 1,
        channel: 'push',
        type: 'planning-published-added',
        title: 'Nouvelle affectation',
        message: 'Vous êtes affecté',
        eventType: 'amical',
        eventId: 'evt-1',
        urgency: 'normal',
        attempts: 2,
      }];
    });
    const db = { query } as unknown as DataSource;

    const item = await enqueueNotificationDelivery(db, baseInput(), 'publish:before:amical:evt-1:cible:added:push');

    expect(item.id).toBe('existing-outbox-id');
    expect(item.attempts).toBe(2);
    const selectSql = query.mock.calls[1]?.[0] as string;
    expect(selectSql).toContain('WHERE idempotency_key = ?');
    expect(query.mock.calls[1]?.[1]).toEqual(['publish:before:amical:evt-1:cible:added:push']);
  });

  it('accepte un EntityManager transactionnel (issue #276) au même titre qu’un DataSource', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => (sql.trim().startsWith('INSERT') ? { affectedRows: 1 } : []));
    const manager = { query } as unknown as DataSource;

    await expect(enqueueNotificationDelivery(manager, baseInput(), 'key-1')).resolves.toMatchObject({
      userId: 1,
      channel: 'push',
    });
  });
});

describe('markNotificationFailed (issue #31)', () => {
  it('stores a classified code instead of the provider message', async () => {
    const query = vi.fn(async () => ({ affectedRows: 1 }));
    const db = { query } as unknown as DataSource;
    const sentinel = 'smtp failed for sentinel.user@example.test';
    await markNotificationFailed(db, 'outbox-1', 0, new Error(sentinel));
    const dumped = JSON.stringify(query.mock.calls);
    expect(dumped).toContain('smtp_failed');
    expect(dumped).toContain('retryable');
    expect(dumped).not.toContain('sentinel.user@example.test');
  });
});
