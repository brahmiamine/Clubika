'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { memo } from 'react';
import {
  Bell,
  Calendar,
  CalendarOff,
  Home,
  LayoutDashboard,
  MessageCircle,
  UserRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { canEdit } from '@/lib/auth/roles';
import { useUnreadNotificationsCount } from '@/hooks/useUnreadNotificationsCount';
import { useUnreadChatCount } from '@/hooks/useUnreadChatCount';
import { notifyChatShowList } from '@/lib/chat/navigation';

interface TabItem {
  href: string;
  label: string;
  icon: typeof Home;
  isActive: (pathname: string) => boolean;
  badge?: number;
}

const isPlanningSection = (pathname: string) =>
  pathname === '/club/planning'
  || pathname.startsWith('/club/planning/')
  || pathname.startsWith('/club/evenements/');

const ADMIN_TABS: Omit<TabItem, 'badge'>[] = [
  { href: '/club', label: 'Événements', icon: LayoutDashboard, isActive: (p) => p === '/club' },
  { href: '/club/planning', label: 'Préparation', icon: Calendar, isActive: isPlanningSection },
  { href: '/club/chat', label: 'Chat', icon: MessageCircle, isActive: (p) => p.startsWith('/club/chat') },
  { href: '/club/notifications', label: 'Notifs', icon: Bell, isActive: (p) => p.startsWith('/club/notifications') },
];

const PERSONAL_TABS: Omit<TabItem, 'badge'>[] = [
  { href: '/mon-planning', label: 'Planning', icon: Home, isActive: (p) => p === '/mon-planning' },
  { href: '/mon-planning/mes-indisponibilites', label: 'Disponib.', icon: CalendarOff, isActive: (p) => p.startsWith('/mon-planning/mes-indisponibilites') },
  { href: '/mon-planning/chat', label: 'Chat', icon: MessageCircle, isActive: (p) => p.startsWith('/mon-planning/chat') },
  { href: '/mon-planning/notifications', label: 'Notifs', icon: Bell, isActive: (p) => p.startsWith('/mon-planning/notifications') },
  { href: '/mon-planning/profil', label: 'Profil', icon: UserRound, isActive: (p) => p.startsWith('/mon-planning/profil') },
];

const HIDDEN_EXACT_PATHS = ['/'];
const HIDDEN_PREFIXES = ['/login', '/plateforme/login', '/inscription', '/mot-de-passe-oublie', '/reinitialiser', '/partage/', '/droits-sans-compte', '/exercice-des-droits', '/confirmer-email'];

export const MobileTabBar = memo(function MobileTabBar() {
  const pathname = usePathname();
  const { user, isLoading } = useCurrentUser();
  const { unread } = useUnreadNotificationsCount();
  const { unread: unreadChat } = useUnreadChatCount();
  const isHiddenRoute =
    HIDDEN_EXACT_PATHS.includes(pathname)
    || HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (isLoading || !user || isHiddenRoute) return null;

  const editable = canEdit(user.accessRole);
  const sourceTabs = editable ? ADMIN_TABS : PERSONAL_TABS;
  const tabs: TabItem[] = sourceTabs.map((tab) => {
    if (tab.href.endsWith('/notifications')) return { ...tab, badge: unread };
    if (tab.href.endsWith('/chat')) return { ...tab, badge: unreadChat };
    return tab;
  });

  return (
    <nav
      className="z-50 w-full shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
      aria-label="Navigation principale"
    >
      <div
        className={cn(
          'mx-auto grid h-[4.5rem] min-h-[4.5rem] max-w-3xl px-1 sm:px-4',
          tabs.length === 4 ? 'grid-cols-4' : 'grid-cols-5',
        )}
      >
        {tabs.map((tab) => {
          const active = tab.isActive(pathname);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              onClick={(event) => {
                if (active && tab.href.endsWith('/chat')) {
                  event.preventDefault();
                  notifyChatShowList();
                }
              }}
              className={cn(
                'flex min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-[10px] font-medium transition-colors sm:text-xs',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'relative flex h-8 w-11 items-center justify-center rounded-full transition-colors',
                  active && 'bg-primary-soft',
                )}
              >
                <Icon className="h-5 w-5 sm:h-[22px] sm:w-[22px]" />
                {!!tab.badge && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold text-destructive-foreground">
                    {tab.badge > 9 ? '9+' : tab.badge}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
});
