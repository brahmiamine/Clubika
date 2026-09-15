import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

describe('GET /api/planning/export/[token] (issue #33)', () => {
  it('rejects an unauthenticated download', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/planning/export/not-a-real-token-value'),
      { params: Promise.resolve({ token: 'not-a-real-token-value' }) },
    );
    expect(response.status).toBe(401);
  });
});
