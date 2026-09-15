import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, PLATFORM_SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { getSessionUser } from '@/lib/auth/session';
import { canEdit, homePathForAccessRole } from '@/lib/auth/roles';
import { PWA_CLUB_ID_HEADER, normalizePwaClubId } from '@/lib/pwa/icons';
import { enforceCsrf } from '@/lib/security/csrf';
import { buildCspReportOnly, newCspNonce } from '@/lib/security/csp';

// Next.js Proxy s'exécute nativement sur le runtime Node.js, nécessaire à getSessionUser (TypeORM).
const LOGIN_PAGE = '/login';

// Portes d'entrée communes à /club et /mon-planning : partagées, à la racine, avant même
// de savoir dans quel espace la session atterrira.
// /sw.js doit rester accessible sans session : un navigateur refuse d'enregistrer un
// service worker dont le script est servi derrière une redirection (ici, vers /login).
const PUBLIC_PAGE_PATHS = ['/login', '/mot-de-passe-oublie', '/manifest.webmanifest', '/offline', '/sw.js', '/inscription'];
// /partage/{token} affiche le planning public : un visiteur anonyme doit pouvoir l'ouvrir
// sans session, le token lui-même (SHA-256, expiration) protégeant l'accès (issue #211).
const PUBLIC_PAGE_PREFIXES = ['/inscription/', '/reinitialiser/', '/partage/'];
// /api/settings GET public ne sert qu'un DTO de marque (nom, couleurs, logo autorisé) ;
// SMTP, flags et champs internes restent derrière une session. L'écriture (PUT)
// reste protégée par requireRole dans le handler lui-même.
// /api/public sert le JSON consommé par /partage/{token} (issue #211) : la validation du
// token (SHA-256, timingSafeEqual, expiration) reste entièrement dans le handler lui-même.
const PUBLIC_API_PREFIXES = ['/api/auth', '/api/cron', '/api/ical', '/api/public', '/api/pwa', '/api/settings', '/api/security'];
// GET /api/invitations/{token} (validation) et POST /api/invitations/{token}/accept (création
// de compte) doivent rester accessibles sans session : la personne invitée n'en a par définition
// pas encore. Le slash final exclut volontairement la racine `/api/invitations` (GET liste /
// POST création), qui reste protégée par requireRole(['admin']) dans son propre handler.
const PUBLIC_API_PREFIXES_WITH_TRAILING_SEGMENT = ['/api/invitations/'];

const PLATFORM_LOGIN_PAGE = '/plateforme/login';
const PLATFORM_LOGIN_API = '/api/plateforme/login';

function isPlausibleSessionToken(value: string | undefined): boolean {
    return !!value && /^[a-f0-9]{64}$/.test(value);
}

/** true pour tout ce qui vit sous /club/... (espace admin, séparé de /mon-planning). */
function isAdminOnlyPage(pathname: string): boolean {
    return pathname === '/club' || pathname.startsWith('/club/');
}

/**
 * /plateforme est un espace distinct (comptes platform_admins, cookie séparé) : il ne doit
 * jamais dépendre d'une session club, sous peine de rendre la connexion plateforme impossible.
 */
function isPlatformRoute(pathname: string): boolean {
    return pathname === '/plateforme' || pathname.startsWith('/plateforme/')
        || pathname === '/api/plateforme' || pathname.startsWith('/api/plateforme/');
}

function applyCsp(response: NextResponse, nonce: string): NextResponse {
    response.headers.set('Content-Security-Policy-Report-Only', buildCspReportOnly(nonce));
    return response;
}

function continueRequest(request: NextRequest, extraRequestHeaders?: Headers): NextResponse {
    const nonce = newCspNonce();
    const requestHeaders = extraRequestHeaders ?? new Headers(request.headers);
    requestHeaders.set('x-nonce', nonce);
    return applyCsp(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
}

function jsonWithCsp(body: unknown, status: number): NextResponse {
    const nonce = newCspNonce();
    const response = NextResponse.json(body, { status });
    return applyCsp(response, nonce);
}

function redirectWithCsp(url: URL): NextResponse {
    const nonce = newCspNonce();
    return applyCsp(NextResponse.redirect(url), nonce);
}

function handlePlatformRoute(request: NextRequest, pathname: string) {
    if (pathname === PLATFORM_LOGIN_PAGE || pathname === PLATFORM_LOGIN_API) {
        return continueRequest(request);
    }

    const platformToken = request.cookies.get(PLATFORM_SESSION_COOKIE_NAME);
    const isPlatformAuthenticated = isPlausibleSessionToken(platformToken?.value);

    if (!isPlatformAuthenticated) {
        if (pathname.startsWith('/api')) {
            return jsonWithCsp({ error: 'Non authentifié' }, 401);
        }
        return redirectWithCsp(new URL(PLATFORM_LOGIN_PAGE, request.url));
    }

    return continueRequest(request);
}

function isStaticAsset(pathname: string): boolean {
    return pathname.startsWith('/_next')
        || pathname.startsWith('/favicon')
        || pathname.startsWith('/icon')
        || pathname.startsWith('/apple-icon')
        || /\.(svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname);
}

function nextWithPwaClubId(request: NextRequest): NextResponse {
    const clubId = normalizePwaClubId(request.nextUrl.searchParams.get('clubId'));
    if (!clubId) return continueRequest(request);

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(PWA_CLUB_ID_HEADER, clubId);
    return continueRequest(request, requestHeaders);
}

function homeForUser(user: Awaited<ReturnType<typeof getSessionUser>>): string {
    return homePathForAccessRole(user?.accessRole);
}

/**
 * Un cookie de session bien formé (64 hex) mais que `getSessionUser` ne résout pas
 * (session révoquée, expirée, utilisateur inactif…) doit être purgé : sinon les
 * gardes basées sur le seul format du token renvoient `/login` vers l'espace, que
 * le client relance aussitôt vers `/login` faute de session réelle — boucle infinie
 * `/login` ↔ `/mon-planning`.
 */
function clearStaleSession(response: NextResponse): NextResponse {
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
}

export async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    if (!isStaticAsset(pathname)) {
        const csrfDenied = enforceCsrf(request);
        if (csrfDenied) return csrfDenied;
    }

    if (isPlatformRoute(pathname)) {
        return handlePlatformRoute(request, pathname);
    }

    if (isStaticAsset(pathname)) {
        return continueRequest(request);
    }

    if (pathname === '/manifest.webmanifest') {
        return nextWithPwaClubId(request);
    }

    const sessionToken = request.cookies.get(SESSION_COOKIE_NAME);
    const hasWellFormedToken = isPlausibleSessionToken(sessionToken?.value);

    const isPublicRoute = PUBLIC_PAGE_PATHS.includes(pathname)
        || PUBLIC_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
        || PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
        || PUBLIC_API_PREFIXES_WITH_TRAILING_SEGMENT.some((prefix) => pathname.startsWith(prefix));

    // Les redirections d'entrée (racine, /login) et le filtre admin dépendent de
    // l'identité réelle : on résout la session en base plutôt que de se fier au
    // seul format du token, pour rester cohérent avec /api/auth/me côté client.
    const needsSessionUser = pathname === '/' || pathname === LOGIN_PAGE || isAdminOnlyPage(pathname);
    const sessionUser = needsSessionUser && hasWellFormedToken
        ? await getSessionUser(sessionToken?.value)
        : null;

    // "/" sert la landing page publique (app/page.tsx) à tout le monde, connecté ou non :
    // le bouton « Commencer » y aiguille ensuite vers /login, /club ou /mon-planning selon
    // la session (voir LandingPage). On purge seulement un cookie de session mort.
    if (pathname === '/') {
        if (!sessionUser && hasWellFormedToken) {
            return clearStaleSession(continueRequest(request));
        }
        return continueRequest(request);
    }

    if (pathname === LOGIN_PAGE) {
        if (sessionUser) {
            return redirectWithCsp(new URL(homeForUser(sessionUser), request.url));
        }
        // Session absente ou périmée : laisser le formulaire s'afficher et purger un
        // éventuel cookie mort pour casser la boucle de redirection.
        return hasWellFormedToken ? clearStaleSession(continueRequest(request)) : continueRequest(request);
    }

    if (!hasWellFormedToken && !isPublicRoute) {
        if (pathname.startsWith('/api')) {
            return jsonWithCsp({ error: 'Non authentifié' }, 401);
        }
        return redirectWithCsp(new URL(LOGIN_PAGE, request.url));
    }

    // Routes API protégées : un cookie bien formé mais session révoquée/expirée/inactive
    // doit être rejeté ici (401 JSON) sans exécuter le handler métier (issue #351, SEC-002).
    if (pathname.startsWith('/api') && !isPublicRoute && hasWellFormedToken) {
        const apiSessionUser = sessionUser ?? await getSessionUser(sessionToken?.value);
        if (!apiSessionUser) {
            return jsonWithCsp({ error: 'Non authentifié' }, 401);
        }
    }

    if (hasWellFormedToken && isAdminOnlyPage(pathname)) {
        if (!sessionUser || !canEdit(sessionUser.accessRole)) {
            return redirectWithCsp(new URL('/mon-planning', request.url));
        }
    }

    return continueRequest(request);
}

export const config = {
    matcher: [
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
};
