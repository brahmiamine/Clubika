import { logError } from '@/lib/observability/log';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { runDuePlanningReminders } from '@/lib/planning/reminders';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { retryPendingNotifications } from '@/lib/notifications/service';
import { runWithClubId } from '@/lib/auth/club-context';
import { listActiveClubIds } from '@/lib/db/club-tenants';

function safeSecretEquals(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function hasValidSecret(request: NextRequest): boolean {
  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret) return false;

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const bearer = authorization.slice('Bearer '.length).trim();
  return bearer.length > 0 && safeSecretEquals(bearer, expectedSecret);
}

export async function POST(request: NextRequest) {
  if (!hasValidSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = await getDb();
    const clubIds = await listActiveClubIds(db);
    const totals = { inspectedEvents: 0, remindersSent: 0, updatedAssignments: 0 };
    const perClub: Record<string, { inspectedEvents: number; remindersSent: number; updatedAssignments: number; disabled?: true }> = {};

    for (const clubId of clubIds) {
      await runWithClubId(clubId, async () => {
        const disabled = await planningFeatureGuard(db, 'automaticReminders');
        const result = disabled
          ? { inspectedEvents: 0, remindersSent: 0, updatedAssignments: 0, disabled: true as const }
          : await runDuePlanningReminders(db);
        perClub[clubId] = result;
        totals.inspectedEvents += result.inspectedEvents;
        totals.remindersSent += result.remindersSent;
        totals.updatedAssignments += result.updatedAssignments;
      });
    }

    const outbox = await retryPendingNotifications(db);
    return NextResponse.json({ success: true, ...totals, perClub, outbox });
  } catch (error) {
    logError('app.unhandled', 'Planning reminders cron failed:', error);
    return NextResponse.json({ error: 'Planning reminders cron failed' }, { status: 500 });
  }
}
