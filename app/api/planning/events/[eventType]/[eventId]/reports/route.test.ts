import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';
import { serializedAuditOmitsReportBody } from '@/lib/planning/report-privacy';

const SECRET = 'UNIQUE_REPORT_BODY_DO_NOT_COPY';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getDb: vi.fn(),
  logAuditEntry: vi.fn(),
  notifyAdmins: vi.fn(),
  setCurrentClubId: vi.fn(),
  planningFeatureGuard: vi.fn(),
  readAppSettings: vi.fn(),
  resolvePlanningEventForAccess: vi.fn(),
  canReadPlanningEventWorkspace: vi.fn(),
  canSubmitPostEventReport: vi.fn(),
  personalPlanningAccessUser: vi.fn(),
  savePlanningRecord: vi.fn(),
  listPlanningRecords: vi.fn(),
  getPlanningRecord: vi.fn(),
  deletePlanningRecord: vi.fn(),
  purgeExpiredPostEventReports: vi.fn(),
}));

vi.mock('@/lib/auth/require', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/db', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/db/audit-log', () => ({ logAuditEntry: mocks.logAuditEntry }));
vi.mock('@/lib/notifications/service', () => ({ notifyAdmins: mocks.notifyAdmins }));
vi.mock('@/lib/auth/club-context', () => ({ setCurrentClubId: mocks.setCurrentClubId }));
vi.mock('@/lib/planning/feature-guard', () => ({ planningFeatureGuard: mocks.planningFeatureGuard }));
vi.mock('@/lib/settings-store', () => ({ readAppSettings: mocks.readAppSettings }));
vi.mock('@/lib/planning/event-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/event-access')>();
  return {
    ...actual,
    resolvePlanningEventForAccess: mocks.resolvePlanningEventForAccess,
    canReadPlanningEventWorkspace: mocks.canReadPlanningEventWorkspace,
    canSubmitPostEventReport: mocks.canSubmitPostEventReport,
    personalPlanningAccessUser: mocks.personalPlanningAccessUser,
  };
});
vi.mock('@/lib/planning/records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/records')>();
  return {
    ...actual,
    savePlanningRecord: mocks.savePlanningRecord,
    listPlanningRecords: mocks.listPlanningRecords,
    getPlanningRecord: mocks.getPlanningRecord,
    deletePlanningRecord: mocks.deletePlanningRecord,
  };
});
vi.mock('@/lib/planning/report-retention', () => ({
  purgeExpiredPostEventReports: mocks.purgeExpiredPostEventReports,
}));

import { DELETE, POST } from './route';

const user = {
  id: 7,
  clubId: 'club-test',
  accessRole: 'admin' as const,
  planningFunctions: [] as string[],
  email: 'admin@example.com',
  nom: 'Admin Test',
};

const snapshot: PlanningEventSnapshot = {
  eventId: 'evt-1',
  eventType: 'entrainement',
  title: 'Entraînement',
  date: '20/09/2026',
  time: '10:00',
  durationMinutes: 90,
  location: 'Terrain A',
  planningStatus: 'published',
  event: {
    id: 'evt-1',
    type: 'entrainement',
    date: '20/09/2026',
    time: '10:00',
    lieu: 'Terrain A',
    encadrants: [],
    planningStatus: 'published',
  },
  extras: null,
  assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
  revision: 0,
};

function postRequest() {
  return new NextRequest('http://localhost/api/planning/events/entrainement/evt-1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'incident', text: SECRET }),
  });
}

describe('POST /api/planning/events/.../reports (issue #8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ user });
    mocks.getDb.mockResolvedValue({ db: true });
    mocks.planningFeatureGuard.mockResolvedValue(null);
    mocks.readAppSettings.mockResolvedValue({ timeZone: 'UTC' });
    mocks.resolvePlanningEventForAccess.mockResolvedValue(snapshot);
    mocks.canReadPlanningEventWorkspace.mockReturnValue(true);
    mocks.canSubmitPostEventReport.mockReturnValue(true);
    mocks.personalPlanningAccessUser.mockReturnValue(user);
    mocks.notifyAdmins.mockResolvedValue(undefined);
    mocks.savePlanningRecord.mockResolvedValue(undefined);
    mocks.logAuditEntry.mockResolvedValue(undefined);
  });

  it('journalise uniquement id, événement et catégorie — jamais le texte', async () => {
    const response = await POST(postRequest(), { params: { eventType: 'entrainement', eventId: 'evt-1' } });
    expect(response).toBeDefined();
    if (!response) throw new Error('POST rapports n’a renvoyé aucune réponse');
    expect(response.status).toBe(200);

    expect(mocks.logAuditEntry).toHaveBeenCalledTimes(1);
    const entry = mocks.logAuditEntry.mock.calls[0]?.[1] as {
      action: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    };
    expect(entry.action).toBe('report');
    expect(entry.after).toMatchObject({
      eventType: 'entrainement',
      eventId: 'evt-1',
      category: 'incident',
    });
    expect(entry.after).toHaveProperty('reportId');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(serializedAuditOmitsReportBody(entry)).toBe(true);

    const notification = mocks.notifyAdmins.mock.calls[0]?.[1] as { message: string };
    expect(notification.message).not.toContain(SECRET);
    expect(notification.message).toContain('incident');
  });
});

describe('DELETE /api/planning/events/.../reports (issue #8)', () => {
  const record = {
    id: 'post-event-report:abc',
    clubId: 'club-test',
    kind: 'post-event-report' as const,
    eventType: 'entrainement',
    eventId: 'evt-1',
    ownerUserId: 7,
    personType: null,
    personId: null,
    tokenHash: null,
    payload: {
      category: 'incident' as const,
      text: SECRET,
      authorUserId: 7,
      authorName: 'Admin Test',
      authorRole: 'admin',
      createdAt: '2026-09-15T00:00:00.000Z',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ user });
    mocks.getDb.mockResolvedValue({ db: true });
    mocks.planningFeatureGuard.mockResolvedValue(null);
    mocks.readAppSettings.mockResolvedValue({ timeZone: 'UTC' });
    mocks.resolvePlanningEventForAccess.mockResolvedValue(snapshot);
    mocks.canReadPlanningEventWorkspace.mockReturnValue(true);
    mocks.personalPlanningAccessUser.mockReturnValue(user);
    mocks.getPlanningRecord.mockResolvedValue(record);
    mocks.deletePlanningRecord.mockResolvedValue(true);
    mocks.logAuditEntry.mockResolvedValue(undefined);
  });

  it('refuse un pair et journalise l’effacement sans le texte', async () => {
    mocks.requireAuth.mockResolvedValue({ user: { ...user, id: 99, accessRole: 'dirigeant' } });
    const forbidden = await DELETE(
      new NextRequest('http://localhost/api/planning/events/entrainement/evt-1/reports?id=post-event-report:abc', {
        method: 'DELETE',
      }),
      { params: { eventType: 'entrainement', eventId: 'evt-1' } },
    );
    expect(forbidden).toBeDefined();
    if (!forbidden) throw new Error('DELETE rapports n’a renvoyé aucune réponse');
    expect(forbidden.status).toBe(403);
    expect(mocks.deletePlanningRecord).not.toHaveBeenCalled();

    mocks.requireAuth.mockResolvedValue({ user });
    const allowed = await DELETE(
      new NextRequest('http://localhost/api/planning/events/entrainement/evt-1/reports?id=post-event-report:abc', {
        method: 'DELETE',
      }),
      { params: { eventType: 'entrainement', eventId: 'evt-1' } },
    );
    expect(allowed).toBeDefined();
    if (!allowed) throw new Error('DELETE rapports n’a renvoyé aucune réponse');
    expect(allowed.status).toBe(200);
    expect(mocks.deletePlanningRecord).toHaveBeenCalledWith({ db: true }, 'post-event-report:abc');
    const entry = mocks.logAuditEntry.mock.calls[0]?.[1] as {
      action: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    };
    expect(entry.action).toBe('delete');
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(serializedAuditOmitsReportBody(entry)).toBe(true);
    expect(entry.after).toEqual({ deleted: true, reason: 'user' });
  });
});
