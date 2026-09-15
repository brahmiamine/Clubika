import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';
import type { PlanningRecord } from '@/lib/planning/records';
import type { ReportPayload } from '@/lib/planning/report-access';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getDb: vi.fn(),
  planningFeatureGuard: vi.fn(),
  resolvePlanningEventForAccess: vi.fn(),
  canReadPlanningEventWorkspace: vi.fn(),
  canSubmitPostEventReport: vi.fn(),
  listPlanningRecords: vi.fn(),
  savePlanningRecord: vi.fn(),
  getPlanningRecord: vi.fn(),
  deletePlanningRecord: vi.fn(),
  logAuditEntry: vi.fn(),
  notifyAdmins: vi.fn(),
  readAppSettings: vi.fn(),
  setCurrentClubId: vi.fn(),
  purgeExpiredPostEventReports: vi.fn(),
}));

vi.mock('@/lib/auth/require', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/db', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/planning/feature-guard', () => ({ planningFeatureGuard: mocks.planningFeatureGuard }));
vi.mock('@/lib/planning/event-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/event-access')>();
  return {
    ...actual,
    resolvePlanningEventForAccess: mocks.resolvePlanningEventForAccess,
    canReadPlanningEventWorkspace: mocks.canReadPlanningEventWorkspace,
    canSubmitPostEventReport: mocks.canSubmitPostEventReport,
  };
});
vi.mock('@/lib/planning/records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/records')>();
  return {
    ...actual,
    listPlanningRecords: mocks.listPlanningRecords,
    savePlanningRecord: mocks.savePlanningRecord,
    getPlanningRecord: mocks.getPlanningRecord,
    deletePlanningRecord: mocks.deletePlanningRecord,
    planningRecordId: () => 'post-event-report:fixed',
  };
});
vi.mock('@/lib/db/audit-log', () => ({ logAuditEntry: mocks.logAuditEntry }));
vi.mock('@/lib/notifications/service', () => ({ notifyAdmins: mocks.notifyAdmins }));
vi.mock('@/lib/settings-store', () => ({ readAppSettings: mocks.readAppSettings }));
vi.mock('@/lib/auth/club-context', () => ({ setCurrentClubId: mocks.setCurrentClubId }));
vi.mock('@/lib/planning/report-retention', () => ({
  purgeExpiredPostEventReports: mocks.purgeExpiredPostEventReports,
}));

import { GET, POST } from './route';
import { DELETE, GET as GET_ONE, PATCH } from './[reportId]/route';

const SENTINEL = 'SENTINEL_REPORT_BODY_DO_NOT_LEAK';

const admin = {
  id: 1,
  clubId: 'club-a',
  email: 'admin@example.com',
  nom: 'Admin Club',
  accessRole: 'admin' as const,
  planningFunctions: [],
  telephone: null,
  indisponibilites: null,
  active: true,
  notifyChannel: 'push' as const,
};

const author = {
  ...admin,
  id: 7,
  email: 'author@example.com',
  nom: 'Auteur Club',
  accessRole: 'dirigeant' as const,
  planningFunctions: ['encadrant' as const],
};

const otherAssigned = {
  ...author,
  id: 8,
  email: 'other@example.com',
  nom: 'Autre Affecte',
};

const snapshot: PlanningEventSnapshot = {
  eventId: 'evt-1',
  eventType: 'entrainement',
  title: 'Entrainement test',
  date: '20/09/2026',
  time: '10:00',
  durationMinutes: 90,
  location: 'Terrain',
  planningStatus: 'published',
  event: {
    id: 'evt-1',
    type: 'entrainement',
    date: '20/09/2026',
    time: '10:00',
    lieu: 'Terrain',
    encadrants: [],
    planningStatus: 'published',
  },
  extras: null,
  assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
  revision: 0,
};

function storedReport(ownerId: number, text = SENTINEL): PlanningRecord<ReportPayload> {
  return {
    id: ownerId === 7 ? 'post-event-report:own' : 'post-event-report:other',
    clubId: 'club-a',
    kind: 'post-event-report',
    eventType: 'entrainement',
    eventId: 'evt-1',
    ownerUserId: ownerId,
    personType: null,
    personId: null,
    tokenHash: null,
    payload: {
      category: 'incident',
      text,
      authorUserId: ownerId,
      authorName: ownerId === 7 ? 'Auteur Club' : 'Autre Affecte',
      authorRole: 'dirigeant',
      createdAt: '2026-09-14T10:00:00.000Z',
    },
    createdAt: new Date('2026-09-14T10:00:00.000Z'),
    updatedAt: new Date('2026-09-14T10:00:00.000Z'),
  };
}

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost${path}`, init);
}

function requireResponse(response: Response | undefined): Response {
  expect(response).toBeDefined();
  if (!response) throw new Error('La route n’a renvoyé aucune réponse');
  return response;
}

const params = { eventType: 'entrainement', eventId: 'evt-1' };
const oneParams = { ...params, reportId: 'post-event-report:own' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockResolvedValue({});
  mocks.planningFeatureGuard.mockResolvedValue(null);
  mocks.readAppSettings.mockResolvedValue({ timeZone: 'UTC' });
  mocks.resolvePlanningEventForAccess.mockResolvedValue(snapshot);
  mocks.canReadPlanningEventWorkspace.mockReturnValue(true);
  mocks.canSubmitPostEventReport.mockReturnValue(true);
  mocks.savePlanningRecord.mockResolvedValue(undefined);
  mocks.logAuditEntry.mockResolvedValue(undefined);
  mocks.notifyAdmins.mockResolvedValue(undefined);
  mocks.deletePlanningRecord.mockResolvedValue(true);
  mocks.purgeExpiredPostEventReports.mockResolvedValue(0);
});

describe('GET /reports (issue #28)', () => {
  it('hides other people’s reports from an assigned non-author', async () => {
    mocks.requireAuth.mockResolvedValue({ user: author });
    mocks.listPlanningRecords.mockResolvedValue([storedReport(7), storedReport(8, 'other-secret')]);

    const response = requireResponse(await GET(request('/api/planning/events/entrainement/evt-1/reports'), { params }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const body = await response.json();
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].id).toBe('post-event-report:own');
    expect(JSON.stringify(body)).not.toContain('other-secret');
    expect(JSON.stringify(body)).not.toContain('Autre Affecte');
    expect(mocks.purgeExpiredPostEventReports).toHaveBeenCalled();
  });

  it('lets a club admin list every report of the tenant without author names', async () => {
    mocks.requireAuth.mockResolvedValue({ user: admin });
    mocks.listPlanningRecords.mockResolvedValue([storedReport(7), storedReport(8, 'other-secret')]);

    const body = await requireResponse(await GET(request('/api/planning/events/entrainement/evt-1/reports'), { params })).json();
    expect(body.reports).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('authorName');
    expect(JSON.stringify(body)).not.toContain('Auteur Club');
  });

  it('returns a uniform 404 when the viewer cannot access the event', async () => {
    mocks.requireAuth.mockResolvedValue({ user: otherAssigned });
    mocks.canReadPlanningEventWorkspace.mockReturnValue(false);
    const response = requireResponse(await GET(request('/api/planning/events/entrainement/evt-1/reports'), { params }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});

describe('POST /reports (issue #28)', () => {
  it('notifies and audits without the report body or author identity', async () => {
    mocks.requireAuth.mockResolvedValue({ user: author });

    const response = requireResponse(await POST(
      request('/api/planning/events/entrainement/evt-1/reports', {
        method: 'POST',
        body: JSON.stringify({ category: 'incident', text: SENTINEL }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params },
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.report.text).toBe(SENTINEL);
    expect(body.report).not.toHaveProperty('authorName');

    expect(mocks.notifyAdmins).toHaveBeenCalledWith({}, expect.objectContaining({
      title: 'Un rapport est disponible',
      message: 'Un rapport est disponible',
    }));
    const notifyPayload = JSON.stringify(mocks.notifyAdmins.mock.calls[0]);
    expect(notifyPayload).not.toContain(SENTINEL);
    expect(notifyPayload).not.toContain('Auteur Club');

    const auditAfter = mocks.logAuditEntry.mock.calls[0]?.[1]?.after;
    expect(auditAfter).toEqual({
      reportId: 'post-event-report:fixed',
      eventType: 'entrainement',
      eventId: 'evt-1',
      category: 'incident',
    });
    expect(JSON.stringify(mocks.logAuditEntry.mock.calls[0])).not.toContain(SENTINEL);
  });
});

describe('GET/PATCH/DELETE /reports/:id (issue #28)', () => {
  it('returns 404 for another assignee without leaking category or author', async () => {
    mocks.requireAuth.mockResolvedValue({ user: otherAssigned });
    mocks.getPlanningRecord.mockResolvedValue(storedReport(7));
    const response = requireResponse(await GET_ONE(request('/api/planning/events/entrainement/evt-1/reports/post-event-report:own'), {
      params: oneParams,
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for a deleted report', async () => {
    mocks.requireAuth.mockResolvedValue({ user: author });
    mocks.getPlanningRecord.mockResolvedValue(null);
    const response = requireResponse(await GET_ONE(request('/api/planning/events/entrainement/evt-1/reports/post-event-report:own'), {
      params: oneParams,
    }));
    expect(response.status).toBe(404);
  });

  it('returns 404 for an admin of another tenant', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { ...admin, id: 99, clubId: 'club-b' } });
    mocks.getPlanningRecord.mockResolvedValue(null);
    const response = requireResponse(await GET_ONE(request('/api/planning/events/entrainement/evt-1/reports/post-event-report:own'), {
      params: oneParams,
    }));
    expect(response.status).toBe(404);
  });

  it('lets the author correct the text without keeping the previous body in audit', async () => {
    mocks.requireAuth.mockResolvedValue({ user: author });
    mocks.getPlanningRecord.mockResolvedValue(storedReport(7));
    const response = requireResponse(await PATCH(
      request('/api/planning/events/entrainement/evt-1/reports/post-event-report:own', {
        method: 'PATCH',
        body: JSON.stringify({ text: 'Texte corrige' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: oneParams },
    ));
    expect(response.status).toBe(200);
    expect(mocks.savePlanningRecord).toHaveBeenCalled();
    expect(JSON.stringify(mocks.logAuditEntry.mock.calls[0])).not.toContain(SENTINEL);
    expect(JSON.stringify(mocks.logAuditEntry.mock.calls[0])).not.toContain('Texte corrige');
  });

  it('lets a former assignee who authored the report delete it, wiping the stored row', async () => {
    mocks.requireAuth.mockResolvedValue({ user: author });
    mocks.getPlanningRecord.mockResolvedValue(storedReport(7));
    const response = requireResponse(await DELETE(
      request('/api/planning/events/entrainement/evt-1/reports/post-event-report:own', { method: 'DELETE' }),
      { params: oneParams },
    ));
    expect(response.status).toBe(200);
    expect(mocks.deletePlanningRecord).toHaveBeenCalledWith({}, 'post-event-report:own');
    expect(JSON.stringify(mocks.logAuditEntry.mock.calls[0])).not.toContain(SENTINEL);
    expect(mocks.logAuditEntry.mock.calls[0]?.[1]?.after).toEqual({ deleted: true, reason: 'user' });
  });
});
