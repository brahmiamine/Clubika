import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
    CLUB_WRITABLE_SETTING_KEYS,
    normalizeAppSettings,
} from '@/lib/settings';
import { readExistingActiveAppSettings, updateAppSettings } from '@/lib/settings-store';
import {
    toAdminClubSettings,
    toMemberClubSettings,
    toPublicClubSettings,
} from '@/lib/settings-public';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getSessionUser } from '@/lib/auth/session';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { BodyValidator, parseJsonBody, RequestValidationError } from '@/lib/validation/request';

const NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
};

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function notFound(): NextResponse {
    return json({ error: 'Not found' }, 404);
}

export async function GET(request: NextRequest) {
    try {
        const user = await getSessionUser(request.cookies.get(SESSION_COOKIE_NAME)?.value);
        const requestedClub = request.nextUrl.searchParams.get('club')?.trim() || null;
        const db = await getDb();

        if (user) {
            if (requestedClub && requestedClub !== user.clubId) {
                return notFound();
            }
            const settings = await readExistingActiveAppSettings(db, user.clubId);
            if (!settings) return notFound();
            return json(
                user.accessRole === 'admin'
                    ? toAdminClubSettings(settings)
                    : toMemberClubSettings(settings),
            );
        }

        const clubId = requestedClub || process.env.APP_CLUB_ID || 'afp';
        const settings = await readExistingActiveAppSettings(db, clubId);
        if (!settings) return notFound();
        return json(toPublicClubSettings(settings));
    } catch (error) {
        logError('app.unhandled', 'Error reading app settings:', error);
        return json({ error: 'Failed to read settings' }, 500);
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
        // GET n'expose plus ces champs ; un round-trip du formulaire ne doit pas 400.
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

        return json({ success: true, settings: toAdminClubSettings(settings) });
    } catch (error) {
        if (error instanceof RequestValidationError) {
            return json({ error: error.message, issues: error.issues }, 400);
        }
        logError('app.unhandled', 'Error updating app settings:', error);
        return json({ error: 'Failed to update settings' }, 500);
    }
}
