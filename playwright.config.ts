import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration E2E (issue #207). Le serveur applicatif (`tsx server.ts`, mode
 * développement) est démarré par Playwright lui-même contre la même MariaDB que les
 * tests d'intégration Vitest (`DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`,
 * défauts identiques à `app/lib/db/data-source.ts`) — jamais de mock, comme le reste
 * de la suite de tests de ce dépôt.
 *
 * L'authentification des scénarios ne passe pas par le formulaire de connexion : les
 * fixtures (`e2e/fixtures.ts`) créent directement des comptes de test en base et posent
 * le cookie de session (`session_token`), exactement comme `createTestUserAndSession`
 * le fait pour les tests d'intégration API — ce qui isole les parcours testés ici des
 * régressions de la page de connexion elle-même (couverte séparément).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3100',
    extraHTTPHeaders: {
      // page.request (APIRequestContext) n’envoie pas Origin comme un fetch navigateur.
      Origin: new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:3100').origin,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'pnpm run dev:app',
    url: 'http://127.0.0.1:3100/login',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: '3100',
    },
  },
});
