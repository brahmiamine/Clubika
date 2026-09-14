import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { ClubTenantEntity } from '@/lib/db/schemas';
import {
    CLUB_WRITABLE_SETTING_KEYS,
    normalizeAppSettings,
    type AppSettings,
} from '@/lib/settings';
import { readAppSettings, updateAppSettings } from '@/lib/settings-store';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getSessionUser } from '@/lib/auth/session';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { BodyValidator, parseJsonBody, RequestValidationError } from '@/lib/validation/request';
import { getClientIp } from '@/lib/auth/client-ip';
import {
    checkLoginRateLimit,
    hashBucketComponent,
    recordFailedLoginAttempt,
} from '@/lib/auth/login-rate-limit';

/**
 * Issue #342 : sans session, `?club=` ne doit pas permettre d'énumérer les clubs
 * (auto-création de tenant, fuite de branding) ni de sonder indéfiniment les ids.
 */
async function resolvePublicSettingsClub(
    request: NextRequest,
): Promise<{ clubId: string } | { error: NextResponse }> {
    const user = await getSessionUser(request.cookies.get(SESSION_COOKIE_NAME)?.value);
    if (user) return { clubId: user.clubId };

    const fromQuery = request.nextUrl.searchParams.get('club')?.trim();
    if (!fromQuery) return { clubId: process.env.APP_CLUB_ID || 'afp' };

    const db = await getDb();
    const ipBucket = `settings-public:ip:${hashBucketComponent(getClientIp(request))}`;
    const ipLimit = await checkLoginRateLimit(db, ipBucket);
    if (ipLimit.limited) {
        return {
            error: NextResponse.json(
                { error: 'Trop de requêtes. Réessayez plus tard.' },
                { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSeconds!) } },
            ),
        };
    }

    const tenant = await db.getRepository<ClubTenantEntity>('ClubTenant').findOneBy({ id: fromQuery });
    if (!tenant?.active) {
        const probeLimit = await recordFailedLoginAttempt(db, ipBucket);
        if (probeLimit.limited) {
            return {
                error: NextResponse.json(
                    { error: 'Trop de requêtes. Réessayez plus tard.' },
                    { status: 429, headers: { 'Retry-After': String(probeLimit.retryAfterSeconds!) } },
                ),
            };
        }
        return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
    }
    return { clubId: fromQuery };
}

/**
 * Les paramètres de scraping sont administrés exclusivement depuis /plateforme.
 * Ils ne sont jamais exposés par l'API de configuration d'un club.
 */
function toClubVisibleSettings(settings: AppSettings): AppSettings {
    return {
        ...settings,
        matchesUrlKey: '',
        scraperClubName: '',
    };
}

export async function GET(request: NextRequest) {
    try {
        const resolved = await resolvePublicSettingsClub(request);
        if ('error' in resolved) return resolved.error;
        const settings = await readAppSettings(await getDb(), resolved.clubId);
        return NextResponse.json(toClubVisibleSettings(settings));
    } catch (error) {
        logError('app.unhandled', 'Error reading app settings:', error);
        return NextResponse.json({ error: 'Failed to read settings' }, { status: 500 });
    }
}

export async function PUT(request: NextRequest) {
    const auth = await requireRole(request, WRITE_ROLES);
    if ('error' in auth) {
        return auth.error;
    }
    setCurrentClubId(auth.user.clubId);

    try {
        const db = await getDb();
        const payload = parseJsonBody(await request.json());
        // GET masque ces champs (chaînes vides) ; un round-trip du formulaire ne doit pas 400.
        // Ils restent ignorés plus bas : seuls /plateforme peut les modifier.
        delete payload.matchesUrlKey;
        delete payload.scraperClubName;
        const v = new BodyValidator(payload);
        v.forbidUnknownFields(CLUB_WRITABLE_SETTING_KEYS);
        v.throwIfInvalid();
        const rawSmtpPassword = payload.smtp && typeof payload.smtp === 'object'
            ? (payload.smtp as Record<string, unknown>).password
            : undefined;
        const smtpPassword = typeof rawSmtpPassword === 'string' ? rawSmtpPassword : undefined;
        const settings = await updateAppSettings(db, auth.user.clubId, (current) => {
            const requested = normalizeAppSettings(payload);
            return {
                ...requested,
                matchesUrlKey: current.matchesUrlKey,
                scraperClubName: current.scraperClubName,
                features: requested.features,
                timeZone: requested.timeZone,
            };
        }, smtpPassword);

        return NextResponse.json({ success: true, settings: toClubVisibleSettings(settings) });
    } catch (error) {
        if (error instanceof RequestValidationError) {
            return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
        }
        logError('app.unhandled', 'Error updating app settings:', error);
        return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
    }
}
