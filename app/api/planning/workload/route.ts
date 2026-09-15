import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { parseDateString } from '@/lib/utils/date';
import type { AssignmentContact, PersonType } from '@/types/match';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { listPlanningEventSnapshots } from '@/lib/planning/event-store';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';

interface WorkloadEntry {
  nom: string;
  personType: PersonType;
  total: number;
  upcoming: number;
  declined: number;
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    // Issue #216 (même correctif que #72 pour le dashboard et /api/planning/analytics) :
    // la charge doit refléter le planning réellement publié, pas le brouillon de travail.
    // Repli sur le live tant que le club n'a jamais publié.
    const publishedSnapshots = await listPublishedPlanningEventSnapshots(db, auth.user.clubId);
    const snapshots = await hydratePlanningAssignmentStates(
      db,
      publishedSnapshots ?? (await listPlanningEventSnapshots(db)),
      auth.user.clubId,
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const entries = new Map<string, WorkloadEntry>();
    const tally = (contacts: AssignmentContact[] | undefined, personType: PersonType, date: string) => {
      (contacts ?? []).forEach((contact) => {
        const nom = contact.nom?.trim();
        if (!nom) return;
        const key = `${personType}::${nom.toLowerCase()}`;
        const entry = entries.get(key) ?? { nom, personType, total: 0, upcoming: 0, declined: 0 };
        entry.total += 1;
        const parsed = parseDateString(date);
        if (!Number.isNaN(parsed.getTime()) && parsed.getTime() >= today.getTime()) entry.upcoming += 1;
        if (contact.status === 'declined') entry.declined += 1;
        entries.set(key, entry);
      });
    };

    for (const snapshot of snapshots) {
      tally(snapshot.assignments.arbitre, 'officiel', snapshot.date);
      tally(snapshot.assignments.encadrant, 'encadrant', snapshot.date);
      tally(snapshot.assignments.accompagnateur, 'accompagnateur', snapshot.date);
    }

    const sorted = Array.from(entries.values()).sort((a, b) => b.total - a.total);
    return NextResponse.json({ entries: sorted });
  } catch (error) {
    logError('app.unhandled', 'Error building planning workload:', error);
    return NextResponse.json({ error: 'Impossible de calculer la charge des dirigeants' }, { status: 500 });
  }
}
