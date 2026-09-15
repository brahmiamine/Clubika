import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { listPlanningEventSnapshots, type PlanningEventType } from '@/lib/planning/event-store';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import { assignmentStatus, isVisiblePublicationStatus } from '@/lib/planning/p0-rules';
import { eventCategory } from '@/lib/planning/public-share';
import { csvCell } from '@/lib/planning/export';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';
import { roleLabelWithClub } from '@/lib/settings';
import { getOfficialMatchesMeta } from '@/lib/db/json-migrator';
import { filterOfficialEventsForDisplay } from '@/lib/planning/official-match-visibility';

const EVENT_TYPES: PlanningEventType[] = ['officiel', 'amical', 'entrainement', 'plateau'];

function html(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isoDate(date: string): string | null {
  const [day, month, year] = date.split('/').map((part) => Number.parseInt(part, 10));
  return day && month && year ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const params = new URL(request.url).searchParams;
  const formatParam = params.get('format');
  const format = formatParam === 'html' ? 'html' : formatParam === 'json' ? 'json' : 'csv';
  const requestedTypes = (params.get('eventTypes') ?? '').split(',').filter(Boolean);
  const types = requestedTypes.filter((type): type is PlanningEventType => EVENT_TYPES.includes(type as PlanningEventType));
  const fromDate = params.get('fromDate');
  const toDate = params.get('toDate');
  const includeDrafts = params.get('includeDrafts') === '1';

  try {
    const db = await getDb();
    const settings = await readAppSettings(db, auth.user.clubId);
    const clubAbbr = settings.clubAbbreviation;
    const arbitresHeader = roleLabelWithClub('Arbitres', clubAbbr);
    const encadrantsHeader = roleLabelWithClub('Encadrants', clubAbbr);
    const accompagnateursHeader = roleLabelWithClub('Accompagnateurs', clubAbbr);
    const live = await listPlanningEventSnapshots(db);
    const published = includeDrafts ? null : await listPublishedPlanningEventSnapshots(db, auth.user.clubId);
    const source = published ?? live;
    const snapshots = filterOfficialEventsForDisplay(
      (await hydratePlanningAssignmentStates(db, source, auth.user.clubId))
        .filter((snapshot) => includeDrafts ? snapshot.planningStatus !== 'cancelled' : isVisiblePublicationStatus(snapshot.planningStatus))
        .filter((snapshot) => !types.length || types.includes(snapshot.eventType))
        .filter((snapshot) => {
          const date = isoDate(snapshot.date);
          if (!date) return false;
          if (fromDate && date < fromDate) return false;
          if (toDate && date > toDate) return false;
          return true;
        }),
      settings,
    );

    if (format === 'json') {
      // Issue #214 : source unique pour les trois formats d'export administrateur — l'export
      // PDF (généré côté client par jsPDF) consommait auparavant les tables brutes non
      // filtrées ; il utilise désormais les mêmes snapshots publiés/brouillon que le CSV/HTML.
      const meta = await getOfficialMatchesMeta(db, auth.user.clubId);
      const events = snapshots.map((snapshot) => snapshot.event);
      const extras: Record<string, unknown> = {};
      for (const snapshot of snapshots) {
        if (snapshot.extras) extras[snapshot.eventId] = snapshot.extras;
      }
      return NextResponse.json(
        { club: meta.club, events, extras },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    const rows = snapshots.map((snapshot) => ({
      type: snapshot.eventType,
      title: snapshot.title,
      date: snapshot.date,
      time: snapshot.time,
      duration: snapshot.durationMinutes,
      location: snapshot.location ?? '',
      category: eventCategory(snapshot) ?? '',
      status: snapshot.planningStatus,
      arbitres: snapshot.assignments.arbitre.filter((contact) => assignmentStatus(contact) !== 'declined').map((contact) => contact.nom).join(' / '),
      encadrants: snapshot.assignments.encadrant.filter((contact) => assignmentStatus(contact) !== 'declined').map((contact) => contact.nom).join(' / '),
      accompagnateurs: snapshot.assignments.accompagnateur.filter((contact) => assignmentStatus(contact) !== 'declined').map((contact) => contact.nom).join(' / '),
    }));

    if (format === 'csv') {
      const headers = ['Type', 'Événement', 'Date', 'Heure', 'Durée', 'Lieu', 'Catégorie', 'Publication', arbitresHeader, encadrantsHeader, accompagnateursHeader];
      const body = [
        headers.map(csvCell).join(','),
        ...rows.map((row) => [row.type, row.title, row.date, row.time, row.duration, row.location, row.category, row.status, row.arbitres, row.encadrants, row.accompagnateurs].map(csvCell).join(',')),
      ].join('\r\n');
      return new NextResponse(`\uFEFF${body}`, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="planning.csv"',
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const tableRows = rows.map((row) => `<tr><td>${html(row.type)}</td><td>${html(row.title)}</td><td>${html(row.date)}</td><td>${html(row.time)}</td><td>${html(row.location)}</td><td>${html(row.category)}</td><td>${html(row.arbitres)}</td><td>${html(row.encadrants)}</td><td>${html(row.accompagnateurs)}</td></tr>`).join('');
    const document = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Planning Clubika</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#111}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #bbb;padding:6px;text-align:left}th{background:#eee}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Imprimer</button><h1>Planning Clubika</h1><table><thead><tr><th>Type</th><th>Événement</th><th>Date</th><th>Heure</th><th>Lieu</th><th>Catégorie</th><th>${html(arbitresHeader)}</th><th>${html(encadrantsHeader)}</th><th>${html(accompagnateursHeader)}</th></tr></thead><tbody>${tableRows}</tbody></table></body></html>`;
    return new NextResponse(document, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    logError('app.unhandled', 'Planning export failed:', error);
    return NextResponse.json({ error: 'Impossible d’exporter le planning' }, { status: 500 });
  }
}
