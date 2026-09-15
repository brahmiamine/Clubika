import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import type { AssignmentContact } from '@/types/match';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { listPlanningEventSnapshots } from '@/lib/planning/event-store';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';

interface OverviewItem {
  eventId: string;
  eventType: 'officiel' | 'amical' | 'entrainement' | 'plateau';
  title: string;
  date: string;
  time: string;
  missingRoles: string[];
  pending: number;
  declined: number;
}

function countStatuses(contacts: AssignmentContact[] | undefined) {
  return (contacts ?? []).reduce((acc, contact) => {
    const status = contact.status ?? 'pending';
    if (status === 'pending') acc.pending += 1;
    if (status === 'declined') acc.declined += 1;
    return acc;
  }, { pending: 0, declined: 0 });
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const snapshots = await hydratePlanningAssignmentStates(
      db,
      await listPlanningEventSnapshots(db),
      auth.user.clubId,
    );
    const items: OverviewItem[] = snapshots.map((snapshot) => {
      const missingRoles: string[] = [];
      if (!snapshot.assignments.encadrant.length) missingRoles.push('Encadrant');
      if (snapshot.eventType === 'officiel' || snapshot.eventType === 'amical') {
        if (!snapshot.assignments.arbitre.length) missingRoles.push('Arbitre');
        if (!snapshot.assignments.accompagnateur.length) missingRoles.push('Accompagnateur');
      }
      const allContacts = Object.values(snapshot.assignments).flat();
      const statuses = countStatuses(allContacts);
      return {
        eventId: snapshot.eventId,
        eventType: snapshot.eventType,
        title: snapshot.title,
        date: snapshot.date,
        time: snapshot.time,
        missingRoles,
        ...statuses,
      };
    });

    const attention = items.filter((item) => item.missingRoles.length > 0 || item.declined > 0 || item.pending > 0);
    return NextResponse.json({
      totals: {
        events: items.length,
        complete: items.filter((item) => item.missingRoles.length === 0 && item.declined === 0 && item.pending === 0).length,
        attention: attention.length,
        missingRoles: items.reduce((sum, item) => sum + item.missingRoles.length, 0),
        pending: items.reduce((sum, item) => sum + item.pending, 0),
        declined: items.reduce((sum, item) => sum + item.declined, 0),
      },
      items: attention,
    });
  } catch (error) {
    logError('app.unhandled', 'Error building planning overview:', error);
    return NextResponse.json({ error: 'Impossible de contrôler le planning' }, { status: 500 });
  }
}
