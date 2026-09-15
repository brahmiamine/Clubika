'use client';

import { useRouter } from 'next/navigation';
import {
  ArrowLeftRight,
  Archive,
  BarChart3,
  Bell,
  Calendar,
  CalendarOff,
  CalendarRange,
  History,
  LayoutDashboard,
  Link2,
  Mail,
  MessageCircle,
  Settings,
  Shield,
  UserRound,
  Users,
} from 'lucide-react';
import { apiPost } from '@/lib/utils/api';
import { toast } from 'sonner';
import { useAppSettings } from '@/hooks/useAppSettings';
import { mergeClubWithSettings, type PlanningFeatureFlags } from '@/lib/settings';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUnreadNotificationsCount } from '@/hooks/useUnreadNotificationsCount';
import { useUnreadChatCount } from '@/hooks/useUnreadChatCount';
import { DashboardShell, type DashboardNavSection } from '@/app/components/layout/DashboardShell';

type FeatureNavSection = Omit<DashboardNavSection, 'items'> & {
  items: Array<DashboardNavSection['items'][number] & { feature?: keyof PlanningFeatureFlags }>;
};

export default function ClubLayoutClient({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, reload } = useCurrentUser();
  const { settings } = useAppSettings();
  const club = mergeClubWithSettings(undefined, settings);
  const { unread } = useUnreadNotificationsCount();
  const { unread: unreadChat } = useUnreadChatCount();

  const handleLogout = async () => {
    try {
      await apiPost('/api/auth/logout');
      toast.success('Déconnexion réussie');
      await reload();
      router.push('/login');
    } catch (error) {
      toast.error('Erreur lors de la déconnexion', { description: error instanceof Error ? error.message : 'Erreur inconnue' });
    }
  };

  const allSections: FeatureNavSection[] = [
    {
      items: [
        { href: '/club', label: 'Événements', icon: LayoutDashboard, exact: true },
      ],
    },
    {
      title: 'Planning',
      items: [
        { href: '/club/planning', label: 'Préparation du planning', icon: Calendar, exact: true },
        { href: '/club/planning/echanges', label: 'Échanges', icon: ArrowLeftRight, feature: 'assignmentSwaps' },
        { href: '/club/planning/charge', label: 'Charge des dirigeants', icon: BarChart3 },
        { href: '/club/planning/statistiques', label: 'Statistiques', icon: BarChart3 },
        { href: '/club/planning/recurrent', label: 'Planning récurrent', icon: CalendarRange, feature: 'recurringEvents' },
        { href: '/club/planning/partage', label: 'Partage public', icon: Link2, feature: 'publicSharing' },
        { href: '/club/planning/historique', label: 'Historique lisible', icon: History },
        { href: '/club/archives', label: 'Archives', icon: Archive },
      ],
    },
    {
      title: 'Terrain',
      items: [
        { href: '/club/indisponibilites', label: 'Indisponibilités', icon: CalendarOff },
      ],
    },
    {
      title: 'Utilisateurs',
      items: [
        { href: '/club/utilisateurs', label: 'Utilisateurs', icon: Users, exact: true },
        { href: '/club/invitations', label: 'Invitations', icon: Mail },
        { href: '/club/droits', label: 'Droits RGPD', icon: Shield },
      ],
    },
    {
      title: 'Compte',
      items: [
        { href: '/club/chat', label: 'Discussions', icon: MessageCircle, badge: unreadChat },
        { href: '/club/notifications', label: 'Notifications', icon: Bell, badge: unread },
        { href: '/club/profil', label: 'Mon profil', icon: UserRound },
      ],
    },
    {
      items: [
        { href: '/club/configuration', label: 'Configuration', icon: Settings },
      ],
    },
  ];

  const sections: DashboardNavSection[] = allSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.feature || settings.features[item.feature]),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <DashboardShell
      brandName={club.name}
      brandTag={settings.clubAbbreviation}
      brandLogo={club.logo}
      brandHref="/club"
      sections={sections}
      userLabel={user?.email}
      onLogout={handleLogout}
    >
      {children}
    </DashboardShell>
  );
}
