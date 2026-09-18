import type { ClubAccessRole } from '@/lib/auth/roles';

/** Routes publiques où l'invite d'installation PWA ne doit jamais apparaître. */
const BLOCKED_EXACT_PATHS = ['/'];

const BLOCKED_PREFIXES = [
  '/login',
  '/plateforme',
  '/partage',
  '/mot-de-passe-oublie',
  '/reinitialiser',
  '/inscription',
  '/droits-sans-compte',
  '/exercice-des-droits',
  '/mentions-legales',
  '/confidentialite',
  '/cgu',
  '/confirmer-email',
];

/** Espaces authentifiés où l'installation PWA peut être proposée. */
const INSTALL_PREFIXES = ['/club', '/mon-planning'];

function isBlockedPath(pathname: string): boolean {
  if (BLOCKED_EXACT_PATHS.includes(pathname)) return true;
  return BLOCKED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function canOfferPwaInstall(
  pathname: string,
  accessRole: ClubAccessRole | null | undefined,
): boolean {
  if (!accessRole) return false;
  if (isBlockedPath(pathname)) return false;

  return INSTALL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Navigateur mobile (Android, iOS…) — le bandeau d'installation s'affiche sur ces appareils. */
export function isMobileUserAgent(userAgent: string): boolean {
  return /android|iphone|ipad|ipod|mobile/i.test(userAgent);
}

export function isIosUserAgent(userAgent: string): boolean {
  return /iphone|ipad|ipod/i.test(userAgent);
}

export function isAndroidUserAgent(userAgent: string): boolean {
  return /android/i.test(userAgent);
}

export function isChromeIosUserAgent(userAgent: string): boolean {
  return isIosUserAgent(userAgent) && /CriOS/i.test(userAgent);
}

/** Consigne d’installation d’application (jamais un raccourci navigateur). */
export function pwaInstallFallbackMessage(userAgent: string, appName: string): string {
  if (isChromeIosUserAgent(userAgent)) {
    return `Pour installer ${appName}, ouvrez cette page dans Safari, puis touchez Partager → « Sur l'écran d'accueil ».`;
  }
  if (isIosUserAgent(userAgent)) {
    return `Pour installer ${appName} : touchez Partager, puis « Sur l'écran d'accueil ».`;
  }
  if (isAndroidUserAgent(userAgent)) {
    return `Pour installer ${appName} : ouvrez le menu ⋮ de Chrome, puis « Installer l'application ».`;
  }
  return `Utilisez le menu de votre navigateur pour installer ${appName}.`;
}
