'use client';

import { createContext, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiGet } from '@/lib/utils/api';
import type { ClubAccessRole, PlanningFunction } from '@/lib/auth/roles';
import type { NotifyChannel } from '@/lib/auth/session';
import type { OfficielIndisponibilite } from '@/lib/utils/officiel-availability';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';

export interface CurrentUser {
  id: number;
  clubId: string;
  email: string;
  nom: string;
  accessRole: ClubAccessRole;
  planningFunctions: PlanningFunction[];
  telephone: string | null;
  indisponibilites: OfficielIndisponibilite[] | null;
  active: boolean;
  notifyChannel: NotifyChannel;
}

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
  reload: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

// `/plateforme` is the platform-admin area: it authenticates independently
// via its own `platform_session_token` cookie (see app/lib/auth/platform-*)
// and must never be redirected by the club-user auth flow below.
const PUBLIC_PREFIXES = ['/login', '/inscription/', '/mot-de-passe-oublie', '/reinitialiser/', '/plateforme', '/partage/', '/exercice-des-droits', '/confirmer-email/'];
// "/" est la landing page publique (app/page.tsx) : comparée en exact, pas en préfixe,
// pour ne pas rendre publiques toutes les routes.
const PUBLIC_EXACT_PATHS = ['/'];

function isPublicPathname(pathname: string): boolean {
  return PUBLIC_EXACT_PATHS.includes(pathname)
    || PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const load = useCallback(async () => {
    try {
      const data = await apiGet<CurrentUser>('/api/auth/me');
      setUser(data);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (isLoading) return;

    const isPublicPath = isPublicPathname(pathname);
    if (!user && !isPublicPath) {
      router.replace('/login');
    }
    // La séparation /club (admin) vs /mon-planning (terrain) est appliquée côté serveur
    // par proxy.ts — pas besoin de la revalider ici.
  }, [isLoading, user, pathname, router]);

  const isPublicPath = isPublicPathname(pathname);

  if (isLoading && !isPublicPath) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user, isLoading, reload: load }}>
      {children}
    </AuthContext.Provider>
  );
}
