'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Building2, FileWarning } from 'lucide-react';
import { apiGet } from '@/lib/utils/api';
import { DashboardShell, type DashboardNavSection } from '@/app/components/layout/DashboardShell';

interface PlatformAdmin {
  id: number;
  email: string;
  nom: string;
}

const sections: DashboardNavSection[] = [
  {
    items: [
      { href: '/plateforme', label: 'Clubs', icon: Building2, exact: true },
      { href: '/plateforme/offboarding', label: 'Fin de contrat', icon: FileWarning },
    ],
  },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [admin, setAdmin] = useState<PlatformAdmin | null>(null);
  const isLoginPage = pathname === '/plateforme/login';

  useEffect(() => {
    if (isLoginPage) return;
    apiGet<{ admin: PlatformAdmin }>('/api/plateforme/me')
      .then((data) => setAdmin(data.admin))
      .catch(() => setAdmin(null));
  }, [isLoginPage]);

  const handleLogout = async () => {
    try {
      await fetch('/api/plateforme/logout', { method: 'POST' });
    } finally {
      router.replace('/plateforme/login');
    }
  };

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <DashboardShell
      brandName="Administration plateforme"
      brandLogo="/branding/clubika-icon.png"
      sections={sections}
      userLabel={admin ? `${admin.nom} (${admin.email})` : undefined}
      onLogout={handleLogout}
    >
      {children}
    </DashboardShell>
  );
}
