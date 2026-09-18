import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

function cronRequest(headers?: HeadersInit, url = 'http://localhost/api/cron/tenant-offboarding') {
  return new NextRequest(url, { method: 'POST', headers });
}

describe('POST /api/cron/tenant-offboarding (issue #25)', () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousPurge = process.env.OFFBOARDING_CRON_PURGE;

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousPurge === undefined) delete process.env.OFFBOARDING_CRON_PURGE;
    else process.env.OFFBOARDING_CRON_PURGE = previousPurge;
  });

  it('rejects a missing or invalid secret', async () => {
    delete process.env.CRON_SECRET;
    expect((await POST(cronRequest())).status).toBe(401);

    process.env.CRON_SECRET = 'expected-secret';
    expect((await POST(cronRequest({ authorization: 'Bearer other-secret' }))).status).toBe(401);
    expect((await POST(cronRequest({ 'x-cron-secret': 'expected-secret' }))).status).toBe(401);
  });
});
