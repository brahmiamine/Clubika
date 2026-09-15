import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/require', () => ({
  requireRole: vi.fn(async () => ({ user: { id: 1, clubId: 'demo', accessRole: 'admin' } })),
}));

import { GET } from './route';

describe('GET /api/settings/external-services (issue #30)', () => {
  it('liste les intégrations désactivées par défaut, sans secret', async () => {
    const response = await GET(new NextRequest('http://localhost/api/settings/external-services'));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      services: Array<{ id: string; enabled: boolean; hostnames: string[] }>;
      notice: string;
    };
    expect(body.services.some((item) => item.enabled)).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/ACCESS_TOKEN|PASSWORD|secret/i);
    expect(body.notice).toMatch(/n’efface aucune donnée/);
  });
});
