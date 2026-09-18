"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useAppSettings } from "@/hooks/useAppSettings";
import { applyDefaultThemeVariables, applyThemeVariables, hasThemeUserOverride } from "@/lib/settings";

// Écrans hors session : ils n'appartiennent à aucun club et ne doivent donc pas
// prendre les couleurs primaire/secondaire d'un club. `/login` est l'entrée
// commune de toute la plateforme et garde la palette par défaut de l'app.
const CLUBLESS_PREFIXES = ["/login", "/mot-de-passe-oublie", "/reinitialiser", "/plateforme", "/inscription", "/droits-sans-compte", "/exercice-des-droits", "/mentions-legales", "/confidentialite", "/cgu", "/confirmer-email"];

function isClublessRoute(pathname: string): boolean {
  if (pathname === "/") return true;
  return CLUBLESS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isPublicShareRoute(pathname: string): boolean {
  return pathname === "/partage" || pathname.startsWith("/partage/");
}

export function AppThemeSync() {
  const { settings } = useAppSettings();
  const { setTheme } = useTheme();
  const pathname = usePathname();

  useEffect(() => {
    if (isPublicShareRoute(pathname)) {
      // Le planning public applique le thème du club concerné,
      // pas celui de la session éventuelle du visiteur.
      return;
    }

    if (isClublessRoute(pathname)) {
      // Palette propre à l'application : la page de connexion affiche ses
      // propres couleurs primaire/secondaire, jamais celles d'un club.
      applyDefaultThemeVariables();
      if (!hasThemeUserOverride()) {
        setTheme("system");
      }
      return;
    }

    applyThemeVariables(settings);
    // Le réglage club (themeMode) sert de thème par défaut. Si l'utilisateur a
    // choisi manuellement un thème via le bouton bascule, on ne l'écrase pas.
    if (!hasThemeUserOverride()) {
      setTheme(settings.themeMode);
    }
  }, [settings, setTheme, pathname]);

  return null;
}
