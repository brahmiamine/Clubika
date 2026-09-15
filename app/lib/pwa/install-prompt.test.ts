import { describe, expect, it } from 'vitest';
import {
  canOfferPwaInstall,
  isAndroidUserAgent,
  isChromeIosUserAgent,
  isIosUserAgent,
  isMobileUserAgent,
  pwaInstallFallbackMessage,
} from './install-prompt';

describe('canOfferPwaInstall', () => {
  it('refuse l’installation sans session', () => {
    expect(canOfferPwaInstall('/club', null)).toBe(false);
    expect(canOfferPwaInstall('/mon-planning', undefined)).toBe(false);
  });

  it('refuse l’installation sur les pages publiques', () => {
    expect(canOfferPwaInstall('/', 'admin')).toBe(false);
    expect(canOfferPwaInstall('/login', 'admin')).toBe(false);
    expect(canOfferPwaInstall('/partage/token', 'dirigeant')).toBe(false);
    expect(canOfferPwaInstall('/mot-de-passe-oublie', 'admin')).toBe(false);
    expect(canOfferPwaInstall('/inscription/abc', 'dirigeant')).toBe(false);
    expect(canOfferPwaInstall('/inscription', 'dirigeant')).toBe(false);
  });

  it('refuse l’installation sur l’espace plateforme', () => {
    expect(canOfferPwaInstall('/plateforme', 'admin')).toBe(false);
    expect(canOfferPwaInstall('/plateforme/login', 'admin')).toBe(false);
  });

  it('autorise l’installation après connexion dans /club ou /mon-planning', () => {
    expect(canOfferPwaInstall('/club', 'admin')).toBe(true);
    expect(canOfferPwaInstall('/club/planning', 'admin')).toBe(true);
    expect(canOfferPwaInstall('/mon-planning', 'dirigeant')).toBe(true);
    expect(canOfferPwaInstall('/mon-planning/profil', 'dirigeant')).toBe(true);
  });
});

describe('détection mobile', () => {
  it('reconnaît Android et iOS', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile')).toBe(true);
    expect(isAndroidUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile')).toBe(true);
    expect(isIosUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
  });

  it('distingue Chrome iOS de Safari', () => {
    expect(
      isChromeIosUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(true);
    expect(isChromeIosUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false);
  });
});

describe('pwaInstallFallbackMessage', () => {
  it('demande une installation d’application, jamais un raccourci', () => {
    const android = pwaInstallFallbackMessage(
      'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile',
      'us-biotoise Planning',
    );
    expect(android).toContain("Installer l'application");
    expect(android.toLowerCase()).not.toContain('raccourci');
    expect(android.toLowerCase()).not.toContain("écran d'accueil");

    const chromeIos = pwaInstallFallbackMessage(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0.0.0 Mobile/15E148',
      'us-biotoise Planning',
    );
    expect(chromeIos).toContain('Safari');
  });
});
