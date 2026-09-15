import { describe, expect, it, vi } from 'vitest';
import { sanitizeAssignmentStateRecord, sanitizeIndisponibilitesForHealthData } from '@/lib/privacy/health-data';
import { migrateHealthDataFields } from './remove-health-data';
import type { DataSource } from 'typeorm';

describe('migration 0026 — retirer données de santé (issue #7)', () => {
  it('recalcule injury vers personal en dry-run et ne purge les commentaires que sur apply', async () => {
    const assignmentState = {
      status: 'declined',
      declineReason: 'injury',
      declineComment: 'commentaire historique',
    };
    let assignmentRows = [{
      clubId: 'club-a',
      eventType: 'amical',
      eventId: 'evt-1',
      role: 'encadrant',
      personKey: 'id:encadrant:1',
      state: JSON.stringify(assignmentState),
    }];
    let userRows = [{
      id: 42,
      indisponibilites: [{
        id: 'r1',
        type: 'day-range',
        dateStart: '01/10/2026',
        dateEnd: '02/10/2026',
        reviewComment: 'texte historique',
      }],
    }];

    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('information_schema.tables')) return [{}];
        if (sql.includes('FROM planning_assignment_state')) return assignmentRows;
        if (sql.includes('FROM users') || sql.includes('SELECT id, indisponibilites')) return userRows;
        if (sql.startsWith('UPDATE planning_assignment_state')) {
          assignmentRows = [{ ...assignmentRows[0]!, state: String(params[0]) }];
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE users')) {
          userRows = [{ ...userRows[0]!, indisponibilites: JSON.parse(String(params[0])) }];
          return { affectedRows: 1 };
        }
        return [];
      },
    } as unknown as DataSource;

    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const dry = await migrateHealthDataFields(db, { purgeComments: false });
      expect(dry.assignmentInjuryRemapped).toBe(1);
      expect(dry.assignmentCommentsPresent).toBe(1);
      expect(dry.assignmentCommentsPurged).toBe(0);
      expect(dry.reviewCommentsPresent).toBe(1);
      expect(dry.reviewCommentsPurged).toBe(0);
      expect(JSON.parse(String(assignmentRows[0]!.state))).toMatchObject({
        declineReason: 'personal',
        declineComment: 'commentaire historique',
      });
      expect(userRows[0]!.indisponibilites[0]).toMatchObject({ reviewComment: 'texte historique' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('commentaire historique');
      expect(JSON.stringify(log.mock.calls)).not.toContain('texte historique');

      const applied = await migrateHealthDataFields(db, { purgeComments: true });
      expect(applied.assignmentCommentsPurged).toBe(1);
      expect(applied.reviewCommentsPurged).toBe(1);
      expect(JSON.parse(String(assignmentRows[0]!.state))).not.toHaveProperty('declineComment');
      expect(userRows[0]!.indisponibilites[0]).not.toHaveProperty('reviewComment');
    } finally {
      log.mockRestore();
    }
  });

  it('les helpers de migration ne tentent pas de classer le texte comme donnée de santé', () => {
    const assignment = sanitizeAssignmentStateRecord(
      { declineReason: 'work', declineComment: 'n’importe quel texte' },
      { purgeComments: true },
    );
    expect(assignment.next.declineReason).toBe('work');
    expect(assignment.next).not.toHaveProperty('declineComment');

    const indispo = sanitizeIndisponibilitesForHealthData(
      [{ id: 'x', type: 'time-slot', date: '01/10/2026', startTime: '09:00', endTime: '11:00', reviewComment: 'n’importe quel texte' }],
      { purgeComments: true },
    );
    expect(indispo.next[0]?.reviewComment).toBeUndefined();
  });
});
