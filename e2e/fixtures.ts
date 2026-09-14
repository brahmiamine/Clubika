import { randomBytes } from 'node:crypto';
import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { getDb } from '@/lib/db';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { ClubAccessRole, PlanningFunction } from '@/lib/auth/roles';
import type { UserEntity } from '@/lib/db/schemas';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3100';
const BASE_ORIGIN = new URL(BASE_URL).origin;

type TestAccount = Awaited<ReturnType<typeof createTestUserAndSession>>;

/**
 * Un club de test dédié par scénario (issue #207) : les fixtures E2E créent leurs propres
 * comptes dans un `clubId` unique généré à l'exécution, jamais dans le club par défaut, pour
 * que plusieurs scénarios puissent tourner (même en parallèle un jour) sans interférer et
 * sans laisser de données résiduelles entre exécutions.
 */
export function freshClubId(): string {
  return `e2e-${randomBytes(8).toString('hex')}`;
}

export async function authedContext(browser: { newContext: () => Promise<BrowserContext> }, account: TestAccount): Promise<BrowserContext> {
  const context = await browser.newContext({
    extraHTTPHeaders: { Origin: BASE_ORIGIN },
  });
  await context.addCookies([{
    name: 'session_token',
    value: account.token,
    url: BASE_URL,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  return context;
}

export async function createAccount(
  accessRole: ClubAccessRole,
  clubId: string,
  planningFunctions: PlanningFunction[] = [],
  overrides: Partial<UserEntity> = {},
): Promise<TestAccount> {
  return createTestUserAndSession(accessRole, { clubId, ...overrides }, planningFunctions);
}

export interface ClubFixture {
  clubId: string;
  admin: TestAccount;
}

export const test = base.extend<{ club: ClubFixture; adminPage: Page }>({
  club: async ({}, use) => {
    const clubId = freshClubId();
    const admin = await createAccount('admin', clubId);
    await use({ clubId, admin });
    await admin.cleanup();
    const db = await getDb();
    await db.query('DELETE FROM planning_records WHERE club_id = ?', [clubId]);
  },

  adminPage: async ({ browser, club }, use) => {
    const context = await authedContext(browser, club.admin);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect } from '@playwright/test';
