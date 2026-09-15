// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLANNING_FEATURES } from '@/lib/settings';
import { PLANNING_FEATURE_SURFACES } from '@/lib/planning/feature-surfaces';
import { PlanningFeaturesTab } from './PlanningFeaturesTab';

vi.mock('@/lib/utils/api', () => ({
  apiGet: vi.fn(async (url: string) => {
    if (url.includes('/scraper')) return { runs: [] };
    if (url.includes('/external-services')) {
      return {
        services: [{
          id: 'smtp',
          label: 'SMTP (e-mail)',
          enabled: false,
          hostnames: [],
          purpose: 'Notifications e-mail',
          dataCategories: ['contact.email'],
          legalReview: 'required',
          enabledEnv: 'SMTP_ENABLED',
        }],
        notice: 'Désactiver une intégration n’efface aucune donnée.',
      };
    }
    return { features: DEFAULT_PLANNING_FEATURES, timeZone: 'Europe/Paris' };
  }),
  apiPut: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('PlanningFeaturesTab — registre unique des flags (issue #279)', () => {
  afterEach(() => cleanup());

  it('affiche un interrupteur pour chaque flag du registre, y compris autoAssignment', async () => {
    render(<PlanningFeaturesTab />);

    await waitFor(() => expect(screen.getByText(PLANNING_FEATURE_SURFACES.autoAssignment.label)).toBeTruthy());

    for (const surface of Object.values(PLANNING_FEATURE_SURFACES)) {
      expect(screen.getByText(surface.label)).toBeTruthy();
    }
    expect(screen.getAllByRole('switch')).toHaveLength(Object.keys(PLANNING_FEATURE_SURFACES).length);
    expect(screen.getByText('Intégrations sortantes')).toBeTruthy();
    expect(screen.getByText('SMTP (e-mail)')).toBeTruthy();
    expect(screen.getByText('Désactivée')).toBeTruthy();
  });

  it('n’affiche plus le réglage « Approbation administrateur » retiré (issue #279)', async () => {
    render(<PlanningFeaturesTab />);

    await waitFor(() => expect(screen.getByText(PLANNING_FEATURE_SURFACES.autoAssignment.label)).toBeTruthy());

    expect(screen.queryByText('Approbation administrateur')).toBeNull();
  });

  it('ne mentionne plus le « Super Admin » (issue #279)', async () => {
    render(<PlanningFeaturesTab />);

    await waitFor(() => expect(screen.getByText(PLANNING_FEATURE_SURFACES.autoAssignment.label)).toBeTruthy());

    expect(screen.queryByText(/super admin/i)).toBeNull();
    expect(screen.getByText(/administrateurs du club/i)).toBeTruthy();
  });
});
