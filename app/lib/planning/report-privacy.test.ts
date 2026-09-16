import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';
import { canDeletePostEventReport } from './event-access';
import {
  containsReportBody,
  isPastReportRetention,
  needsReportAuditRedaction,
  postEventReportRetentionDays,
  redactReportAuditPayload,
  reportAuditAfter,
  serializedAuditOmitsReportBody,
} from './report-privacy';

const SECRET = 'UNIQUE_REPORT_BODY_DO_NOT_COPY';

const admin: SessionUser = {
  id: 1,
  clubId: 'afp',
  email: 'admin@example.com',
  nom: 'Admin',
  accessRole: 'admin',
  planningFunctions: [],
  telephone: null,
  indisponibilites: null,
  active: true,
  notifyChannel: 'push',
};

const author: SessionUser = {
  ...admin,
  id: 7,
  accessRole: 'dirigeant',
  planningFunctions: ['encadrant'],
  nom: 'Auteur',
  email: 'auteur@example.com',
};

describe('report audit minimization (issue #8)', () => {
  it('serializes only report id, event, and category — never the body', () => {
    const after = reportAuditAfter({
      reportId: 'post-event-report:abc',
      eventType: 'officiel',
      eventId: 'm1',
      category: 'incident',
    });
    const blob = JSON.stringify({ action: 'report', before: null, after });
    expect(blob).not.toContain(SECRET);
    expect(after).toEqual({
      reportId: 'post-event-report:abc',
      eventType: 'officiel',
      eventId: 'm1',
      category: 'incident',
    });
    expect(serializedAuditOmitsReportBody({ before: null, after })).toBe(true);
  });

  it('detects a legacy after payload that copied the report text', () => {
    const after = {
      category: 'incident',
      text: SECRET,
      authorUserId: 7,
      authorName: 'Auteur',
      authorRole: 'dirigeant',
      createdAt: '2026-09-15T00:00:00.000Z',
    };
    expect(containsReportBody(after)).toBe(true);
    expect(needsReportAuditRedaction(null, after)).toBe(true);
    const redacted = redactReportAuditPayload(after, { reportId: 'post-event-report:abc', redacted: true });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted).not.toHaveProperty('text');
    expect(redacted).not.toHaveProperty('authorName');
    expect(redacted?.category).toBe('incident');
    expect(redacted?.reportId).toBe('post-event-report:abc');
    expect(serializedAuditOmitsReportBody({ before: null, after: redacted })).toBe(true);
  });

  it('lets the author or a club admin delete a report, not a peer', () => {
    const record = { ownerUserId: 7 };
    expect(canDeletePostEventReport(author, record)).toBe(true);
    expect(canDeletePostEventReport(admin, record)).toBe(true);
    expect(canDeletePostEventReport({ ...author, id: 99 }, record)).toBe(false);
  });

  it('treats reports older than the operational retention as expired', () => {
    expect(postEventReportRetentionDays()).toBeGreaterThanOrEqual(1);
    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    const now = new Date('2026-09-15T00:00:00.000Z');
    expect(isPastReportRetention(createdAt, now, 365)).toBe(true);
    expect(isPastReportRetention(now, now, 365)).toBe(false);
  });
});
