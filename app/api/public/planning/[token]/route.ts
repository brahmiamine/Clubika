import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { listPlanningEventSnapshots } from '@/lib/planning/event-store';
import { isVisiblePublicationStatus } from '@/lib/planning/p0-rules';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import { getPlanningRecordByTokenHash } from '@/lib/planning/records';
import {
  hashShareToken,
  isSnapshotInShareScope,
  toPublicPlanningItem,
  type PublicShareScope,
} from '@/lib/planning/public-share';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import { createTeamLogoResolver } from '@/lib/planning/team-logos';
import { DEFAULT_APP_SETTINGS } from '@/lib/settings';
import { isPlanningFeatureEnabled, readAppSettings } from '@/lib/settings-store';
import { filterOfficialEventsForDisplay } from '@/lib/planning/official-match-visibility';
import { sortByDateAndTime } from '@/lib/db/helpers';
import { getPlanningWeather, toPublicEventWeather } from '@/lib/planning/weather';
import {
  checkCapabilityIpRateLimit,
  checkCapabilityTokenRateLimit,
  recordCapabilityIpAttempt,
  recordCapabilityTokenAttempt,
} from '@/lib/auth/capability-rate-limit';

const RATE_LIMIT_ROUTE_KEY = 'public-share';

interface PublicSharePayload {
  tokenHash: string;
  expiresAt: string;
  scope: PublicShareScope;
  createdByUserId: number;
}

async function rejectInvalidPublicShare(
  db: Awaited<ReturnType<typeof getDb>>,
  request: NextRequest,
  token: string,
) {
  await recordCapabilityTokenAttempt(db, RATE_LIMIT_ROUTE_KEY, token);
  await recordCapabilityIpAttempt(db, request, RATE_LIMIT_ROUTE_KEY);
  return NextResponse.json({ error: 'Lien de partage expiré ou invalide' }, { status: 404 });
}

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;

  try {
    const db = await getDb();
    const ipBlocked = await checkCapabilityIpRateLimit(db, request, RATE_LIMIT_ROUTE_KEY);
    if (ipBlocked) return ipBlocked;
    const tokenBlocked = await checkCapabilityTokenRateLimit(db, RATE_LIMIT_ROUTE_KEY, token);
    if (tokenBlocked) return tokenBlocked;

    if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) {
      return rejectInvalidPublicShare(db, request, token);
    }
    // Résolution indexée directe (issue #277) : reste O(1) quel que soit le nombre de
    // liens de partage émis depuis, par ce club ou n'importe quel autre — plus de
    // balayage des 1000 enregistrements les plus récents.
    const hash = hashShareToken(token);
    const share = await getPlanningRecordByTokenHash<PublicSharePayload>(db, hash);
    if (!share || share.kind !== 'public-share' || Date.parse(share.payload.expiresAt) <= Date.now()) {
      return rejectInvalidPublicShare(db, request, token);
    }
    // Un lien par ailleurs valide ne doit plus donner accès une fois le club désactivé
    // (issue #213) : même message que le jeton expiré/invalide, pour ne pas révéler
    // l'existence ni l'état du club côté client.
    if (!(await isClubTenantActive(db, share.clubId))) {
      return rejectInvalidPublicShare(db, request, token);
    }
    setCurrentClubId(share.clubId);
    const disabled = await planningFeatureGuard(db, 'publicSharing');
    if (disabled) return disabled;

    const publishedSnapshots = await listPublishedPlanningEventSnapshots(db);
    const visibleSnapshots = publishedSnapshots
      ?? (await listPlanningEventSnapshots(db)).filter((snapshot) => isVisiblePublicationStatus(snapshot.planningStatus));

    const [resolveLogos, settings, weatherEnabled] = await Promise.all([
      createTeamLogoResolver(db, share.clubId),
      readAppSettings(db, share.clubId).catch(() => null),
      isPlanningFeatureEnabled(db, share.clubId, 'travelAndWeather'),
    ]);

    const scopedSnapshots = sortByDateAndTime(
      filterOfficialEventsForDisplay(
        visibleSnapshots
          // Le snapshot publié conserve volontairement les événements annulés (pour que « Mon
          // planning » et l'export iCal affichent le badge « Annulé ») : le lien public, qui ne
          // transporte aucun statut, doit les exclure plutôt que de les montrer comme maintenus.
          .filter((snapshot) => isVisiblePublicationStatus(snapshot.planningStatus))
          .filter((snapshot) => isSnapshotInShareScope(snapshot, share.payload.scope)),
        settings ?? DEFAULT_APP_SETTINGS,
      ),
    );
    const items = await Promise.all(
      scopedSnapshots.map(async (snapshot) => {
        const item = toPublicPlanningItem(snapshot, resolveLogos);
        if (!weatherEnabled) return item;
        const weather = toPublicEventWeather(
          await getPlanningWeather(db, snapshot.eventType, snapshot.eventId),
        );
        return { ...item, weather };
      }),
    );

    return NextResponse.json(
      {
        expiresAt: share.payload.expiresAt,
        generatedAt: new Date().toISOString(),
        scope: share.payload.scope,
        club: {
          id: share.clubId,
          name: settings?.clubName ?? null,
          logo: settings?.clubLogo ?? null,
          primaryColor: settings?.primaryColor ?? DEFAULT_APP_SETTINGS.primaryColor,
          accentColor: settings?.accentColor ?? DEFAULT_APP_SETTINGS.accentColor,
          themeMode: settings?.themeMode ?? DEFAULT_APP_SETTINGS.themeMode,
        },
        items,
      },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (error) {
    logError('app.unhandled', 'Public planning share failed:', error);
    return NextResponse.json({ error: 'Impossible de charger ce planning' }, { status: 500 });
  }
}
