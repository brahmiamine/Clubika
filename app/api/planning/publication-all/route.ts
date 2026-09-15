import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { setCurrentClubId } from '@/lib/auth/club-context';
import {
  getGlobalPlanningPublicationPreview,
  publishGlobalPlanning,
} from '@/lib/planning/global-publication';
import { PlanningValidationError } from '@/lib/planning/validation';
import { PlanningConcurrencyError } from '@/lib/planning/event-store';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    return NextResponse.json(await getGlobalPlanningPublicationPreview(await getDb()));
  } catch (error) {
    logError('app.unhandled', 'Global planning publication preview failed:', error);
    return NextResponse.json({ error: 'Impossible de préparer la publication du planning' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const result = await publishGlobalPlanning(await getDb(), auth.user);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof PlanningValidationError) {
      return NextResponse.json({ error: error.message, blockers: error.details }, { status: 409 });
    }
    if (error instanceof PlanningConcurrencyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logError('app.unhandled', 'Global planning publication failed:', error);
    return NextResponse.json({ error: 'Impossible de publier le planning' }, { status: 500 });
  }
}
