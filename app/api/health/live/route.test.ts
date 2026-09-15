import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/health/live', () => {
  it('returns a secret-free liveness payload without touching the database', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'live' });
    expect(JSON.stringify(body)).not.toMatch(/password|secret|token|email|club/i);
  });
});
