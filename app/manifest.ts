import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { resolvePwaBranding, APP_PRODUCT_CLUB_ID } from '@/lib/pwa/branding';
import { PWA_START_URL } from '@/lib/pwa/display-mode';
import { buildPwaManifestIcons, clubIdFromRequestHeaders } from '@/lib/pwa/icons';

export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const headerStore = await headers();
  const branding = await resolvePwaBranding(clubIdFromRequestHeaders((name) => headerStore.get(name)));

  return {
    id: branding.clubId === APP_PRODUCT_CLUB_ID ? '/' : `/?clubId=${encodeURIComponent(branding.clubId)}`,
    name: branding.name,
    short_name: branding.shortName,
    description: branding.description,
    start_url: PWA_START_URL,
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait-primary',
    background_color: branding.backgroundColor,
    theme_color: branding.primaryColor,
    prefer_related_applications: false,
    lang: 'fr',
    categories: ['sports', 'productivity'],
    launch_handler: { client_mode: 'navigate-existing' },
    icons: buildPwaManifestIcons(branding.clubId, branding.iconVersion),
  };
}
