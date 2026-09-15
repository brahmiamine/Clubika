import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';
import type { PlanningRecord } from '@/lib/planning/records';
import {
  REPORT_AVAILABLE_NOTICE,
  canDeleteReport,
  canReadReport,
  canUpdateReport,
  filterVisibleReports,
  paginateReports,
  parseReportPage,
  reportAuditMeta,
  toVisibleReport,
  type ReportPayload,
} from './report-access';

const admin: SessionUser = {
  id: 1,
  clubId: 'club-a',
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
  email: 'author@example.com',
  nom: 'Auteur',
  accessRole: 'dirigeant',
  planningFunctions: ['encadrant'],
};

const assignedOther: SessionUser = {
  ...author,
  id: 8,
  email: 'other@example.com',
  nom: 'Autre affecté',
};

const otherTenantAdmin: SessionUser = {
  ...admin,
  id: 99,
  clubId: 'club-b',
  email: 'other-admin@example.com',
};

const secretText = 'SENTINEL_REPORT_BODY_DO_NOT_LEAK';

function record(overrides: Partial<PlanningRecord<ReportPayload>> = {}): PlanningRecord<ReportPayload> {
  return {
    id: 'post-event-report:1',
    clubId: 'club-a',
    kind: 'post-event-report',
    eventType: 'entrainement',
    eventId: 'evt-1',
    ownerUserId: 7,
    personType: null,
    personId: null,
    tokenHash: null,
    payload: {
      category: 'incident',
      text: secretText,
      authorUserId: 7,
      authorName: 'Auteur',
      authorRole: 'dirigeant',
      createdAt: '2026-09-14T10:00:00.000Z',
    },
    createdAt: new Date('2026-09-14T10:00:00.000Z'),
    updatedAt: new Date('2026-09-14T10:00:00.000Z'),
    ...overrides,
  };
}

describe('report access matrix (issue #28)', () => {
  it('lets the author and same-tenant admin read, not another assignee or foreign admin', () => {
    const stored = record();
    expect(canReadReport(author, stored)).toBe(true);
    expect(canReadReport(admin, stored)).toBe(true);
    expect(canReadReport(assignedOther, stored)).toBe(false);
    expect(canReadReport(otherTenantAdmin, stored)).toBe(false);
  });

  it('lets only the author update', () => {
    const stored = record();
    expect(canUpdateReport(author, stored)).toBe(true);
    expect(canUpdateReport(admin, stored)).toBe(false);
    expect(canUpdateReport(assignedOther, stored)).toBe(false);
  });

  it('lets the author and same-tenant admin delete', () => {
    const stored = record();
    expect(canDeleteReport(author, stored)).toBe(true);
    expect(canDeleteReport(admin, stored)).toBe(true);
    expect(canDeleteReport(assignedOther, stored)).toBe(false);
    expect(canDeleteReport(otherTenantAdmin, stored)).toBe(false);
  });

  it('filters list items so an assignee only sees their own reports', () => {
    const own = record();
    const other = record({
      id: 'post-event-report:2',
      ownerUserId: 8,
      payload: { ...own.payload, authorUserId: 8, authorName: 'Autre affecté', text: 'other-secret' },
    });
    const visible = filterVisibleReports(author, [own, other]);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(own.id);
    expect(JSON.stringify(visible)).not.toContain('other-secret');
    expect(JSON.stringify(visible)).not.toContain('Autre affecté');
  });

  it('builds a DTO without author identity fields', () => {
    const dto = toVisibleReport(author, record());
    expect(Object.keys(dto).sort()).toEqual(['canDelete', 'canUpdate', 'category', 'createdAt', 'id', 'text']);
    expect(dto).not.toHaveProperty('authorName');
    expect(dto).not.toHaveProperty('authorUserId');
    expect(dto).not.toHaveProperty('authorRole');
    expect(dto.canUpdate).toBe(true);
    expect(dto.canDelete).toBe(true);
  });

  it('never puts the report body in audit metadata', () => {
    const meta = reportAuditMeta('post-event-report:1');
    expect(meta).toEqual({ reportId: 'post-event-report:1' });
    expect(JSON.stringify(meta)).not.toContain(secretText);
    expect(REPORT_AVAILABLE_NOTICE).toBe('Un rapport est disponible');
    expect(REPORT_AVAILABLE_NOTICE).not.toContain(secretText);
  });

  it('paginates the filtered list', () => {
    const items = filterVisibleReports(admin, [
      record({ id: 'post-event-report:1' }),
      record({ id: 'post-event-report:2' }),
      record({ id: 'post-event-report:3' }),
    ]);
    expect(paginateReports(items, 2, 0).reports).toHaveLength(2);
    expect(paginateReports(items, 2, 2).total).toBe(3);
    expect(parseReportPage(new URLSearchParams('limit=999&offset=-4'))).toEqual({ limit: 50, offset: 0 });
  });
});
