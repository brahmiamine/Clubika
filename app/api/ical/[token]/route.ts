import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { UserEntity } from '@/lib/db/schemas';
import { Match, Entrainement, Plateau, type PersonType } from '@/types/match';
import { MatchExtras } from '@/hooks/useMatchExtras';
import { generateIcal, type IcalIdentity } from '@/lib/utils/ical-export';
import { getOfficialMatchesMeta } from '@/lib/db/json-migrator';
import { normalizePlanningFunctions } from '@/lib/auth/roles';
import { readAppSettings } from '@/lib/settings-store';
import { filterOfficialEventsForDisplay } from '@/lib/planning/official-match-visibility';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import { personTypeForFunction } from '@/lib/planning/person-link';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import {
  checkCapabilityIpRateLimit,
  checkCapabilityTokenRateLimit,
  recordCapabilityIpAttempt,
  recordCapabilityTokenAttempt,
} from '@/lib/auth/capability-rate-limit';

const RATE_LIMIT_ROUTE_KEY = 'ical-feed';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import {
  parseEntrainementPayload,
  parseMatchExtrasPayload,
  parseMatchPayload,
  parsePlateauPayload,
} from '@/lib/db/planning-payload-codecs';

type Event = Match | Entrainement | Plateau;

const ROLE_FOR_PERSON_TYPE: Record<PersonType, IcalIdentity['role']> = {
  officiel: 'arbitre',
  encadrant: 'encadrant',
  accompagnateur: 'accompagnateur',
};

async function rejectInvalidIcalFeed(
  db: Awaited<ReturnType<typeof getDb>>,
  request: NextRequest,
  token: string,
) {
  await recordCapabilityTokenAttempt(db, RATE_LIMIT_ROUTE_KEY, token);
  await recordCapabilityIpAttempt(db, request, RATE_LIMIT_ROUTE_KEY);
  return NextResponse.json({ error: 'Lien de calendrier invalide' }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } }
) {
  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const token = resolvedParams.token;

    const db = await getDb();
    const ipBlocked = await checkCapabilityIpRateLimit(db, request, RATE_LIMIT_ROUTE_KEY);
    if (ipBlocked) return ipBlocked;
    const tokenBlocked = await checkCapabilityTokenRateLimit(db, RATE_LIMIT_ROUTE_KEY, token);
    if (tokenBlocked) return tokenBlocked;

    const user = await db.getRepository<UserEntity>('User').findOneBy({ icalToken: token });
    if (!user || !user.active) {
      return rejectInvalidIcalFeed(db, request, token);
    }
    // Un jeton par ailleurs valide ne doit plus donner accès une fois le club désactivé
    // (issue #213) : même message que le jeton invalide, pour ne pas révéler l'existence du club.
    if (!(await isClubTenantActive(db, user.clubId))) {
      return rejectInvalidIcalFeed(db, request, token);
    }
    setCurrentClubId(user.clubId);
    const disabled = await planningFeatureGuard(db, 'calendarExport');
    if (disabled) return disabled;

    const clubId = user.clubId;
    const [publishedSnapshotsRaw, meta, settings] = await Promise.all([
      listPublishedPlanningEventSnapshots(db),
      getOfficialMatchesMeta(db, clubId),
      readAppSettings(db, clubId),
    ]);

    let events: Event[];
    const allExtras: Record<string, MatchExtras> = {};

    if (publishedSnapshotsRaw) {
      const publishedSnapshots = await hydratePlanningAssignmentStates(db, publishedSnapshotsRaw, clubId);
      events = filterOfficialEventsForDisplay(
        publishedSnapshots.map((snapshot) => snapshot.event as Event),
        settings,
      );
      for (const snapshot of publishedSnapshots) {
        if (snapshot.extras?.id) allExtras[snapshot.extras.id] = snapshot.extras;
      }
    } else {
      const [officialRows, amicalRows, entrainementRows, plateauRows, extraRows] = await Promise.all([
        db.getRepository('MatchOfficial').findBy({ clubId }),
        db.getRepository('MatchAmical').findBy({ clubId }),
        db.getRepository('Entrainement').findBy({ clubId }),
        db.getRepository('Plateau').findBy({ clubId }),
        db.getRepository('MatchExtra').findBy({ clubId }),
      ]);
      events = filterOfficialEventsForDisplay(
        [
          ...officialRows.map((row) => parseMatchPayload(row.payload, 'MatchOfficial', { id: row.id, type: 'officiel' })).filter((item) => Boolean(item?.id)),
          ...amicalRows.map((row) => parseMatchPayload(row.payload, 'MatchAmical', { id: row.id, type: 'amical' })).filter((item) => Boolean(item?.id)),
          ...entrainementRows.map((row) => parseEntrainementPayload(row.payload, row.id)).filter((item) => Boolean(item?.id)),
          ...plateauRows.map((row) => parsePlateauPayload(row.payload, row.id)).filter((item) => Boolean(item?.id)),
        ],
        settings,
      );
      for (const row of extraRows) {
        const payload = parseMatchExtrasPayload(row.payload, row.matchId);
        if (payload?.id) allExtras[payload.id] = payload;
      }
    }

    const identities: IcalIdentity[] = normalizePlanningFunctions(user.planningFunctions).map((planningFunction) => {
      const personType = personTypeForFunction(planningFunction);
      return {
        personNom: user.nom,
        personId: user.id,
        personType,
        role: ROLE_FOR_PERSON_TYPE[personType],
      };
    });

    const icsContent = generateIcal(
      events,
      allExtras,
      meta.club,
      { identities, timeZone: settings.timeZone, clubId },
      settings.clubAbbreviation,
    );

    return new NextResponse(icsContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="planning.ics"',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    logError('app.unhandled', 'Erreur GET ical feed:', error);
    return NextResponse.json({ error: 'Une erreur est survenue' }, { status: 500 });
  }
}
