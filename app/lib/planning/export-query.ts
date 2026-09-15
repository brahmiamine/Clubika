import type { DataSource } from 'typeorm';
import type { PlanningEventType } from '@/lib/planning/event-store';
import { listPlanningEventSnapshots } from '@/lib/planning/event-store';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import { isVisiblePublicationStatus } from '@/lib/planning/p0-rules';
import { filterOfficialEventsForDisplay } from '@/lib/planning/official-match-visibility';
import { readAppSettings } from '@/lib/settings-store';
import type { AppSettings } from '@/lib/settings';
import {
  projectExportRow,
  type ExportColumnId,
} from '@/lib/planning/export';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';

const EVENT_TYPES: PlanningEventType[] = ['officiel', 'amical', 'entrainement', 'plateau'];

function isoDate(date: string): string | null {
  const [day, month, year] = date.split('/').map((part) => Number.parseInt(part, 10));
  return day && month && year ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

export function normalizeExportEventTypes(value: unknown): PlanningEventType[] {
  const raw = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const types = raw.filter((type): type is PlanningEventType => EVENT_TYPES.includes(type as PlanningEventType));
  return types.length ? [...new Set(types)] : [...EVENT_TYPES];
}

export async function listExportSnapshots(
  db: DataSource,
  clubId: string,
  input: {
    eventTypes: PlanningEventType[];
    fromDate: string | null;
    toDate: string | null;
    includeDrafts: boolean;
    settings?: AppSettings;
  },
): Promise<PlanningEventSnapshot[]> {
  const settings = input.settings ?? await readAppSettings(db, clubId);
  const live = await listPlanningEventSnapshots(db);
  const published = input.includeDrafts ? null : await listPublishedPlanningEventSnapshots(db, clubId);
  const source = published ?? live;
  return filterOfficialEventsForDisplay(
    (await hydratePlanningAssignmentStates(db, source, clubId))
      .filter((snapshot) => (
        input.includeDrafts
          ? snapshot.planningStatus !== 'cancelled'
          : isVisiblePublicationStatus(snapshot.planningStatus)
      ))
      .filter((snapshot) => input.eventTypes.includes(snapshot.eventType))
      .filter((snapshot) => {
        const date = isoDate(snapshot.date);
        if (!date) return false;
        if (input.fromDate && date < input.fromDate) return false;
        if (input.toDate && date > input.toDate) return false;
        return true;
      }),
    settings,
  );
}

export function projectExportRows(
  snapshots: PlanningEventSnapshot[],
  columns: readonly ExportColumnId[],
  includePhones: boolean,
): Array<Record<string, string>> {
  return snapshots.map((snapshot) => projectExportRow(snapshot, columns, includePhones));
}
