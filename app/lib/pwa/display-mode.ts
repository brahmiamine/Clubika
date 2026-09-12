/**
 * L’app installée (PWA) ne doit pas ouvrir la landing marketing `/`.
 * `/login` redirige déjà une session valide vers `/club` ou `/mon-planning`
 * (voir proxy.ts). Les WebAPK déjà installés avec `start_url: /` sont
 * rattrapés côté client via `isStandaloneDisplay()`.
 */
export const PWA_START_URL = '/login';

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches
    || navigatorWithStandalone.standalone === true;
}
