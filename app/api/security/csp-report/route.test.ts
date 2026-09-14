import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { POST } from './route';

const dbAvailable = await isDbAvailable();

describe('sanitize + POST /api/security/csp-report (issue #35)', () => {
  it('n’accepte que des hôtes, jamais une URI complète ni un cookie', async () => {
    const { sanitizeCspReport } = await import('@/lib/security/csp');
    const sanitized = sanitizeCspReport({
      'csp-report': {
        'document-uri': 'https://clubika.com/club/invitations?token=secret-value',
        referrer: 'https://evil.example/steal?cookie=abc',
        'blocked-uri': 'https://cdn.evil/x.js?session=tok_live_123',
        'violated-directive': "script-src 'self'",
        'source-file': 'https://clubika.com/club/users/42',
      },
    });
    expect(sanitized).toEqual({
      documentHost: 'clubika.com',
      blockedHost: 'cdn.evil',
      violatedDirective: 'script-src',
      disposition: 'report',
    });
    expect(JSON.stringify(sanitized)).not.toContain('secret-value');
    expect(JSON.stringify(sanitized)).not.toContain('tok_live');
    expect(JSON.stringify(sanitized)).not.toContain('/club/');
  });
});

describe.skipIf(!dbAvailable)('POST /api/security/csp-report (integration)', () => {
  it('enregistre un rapport sanitisé et répond 204', async () => {
    const ip = randomBytes(8).toString('hex');
    const db = await getDb();
    try {
      const response = await POST(new NextRequest('http://localhost/api/security/csp-report', {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report', 'x-forwarded-for': ip },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://clubika.com/club/planning?token=should-not-persist',
            'blocked-uri': 'https://tracker.example/n.js',
            'violated-directive': 'script-src',
          },
        }),
      }));
      expect(response.status).toBe(204);

      const rows = await db.query(
        'SELECT document_host AS documentHost, blocked_host AS blockedHost, violated_directive AS violatedDirective FROM csp_reports ORDER BY id DESC LIMIT 1',
      ) as Array<{ documentHost: string; blockedHost: string; violatedDirective: string }>;
      expect(rows[0]).toMatchObject({
        documentHost: 'clubika.com',
        blockedHost: 'tracker.example',
        violatedDirective: 'script-src',
      });
      expect(JSON.stringify(rows[0])).not.toContain('should-not-persist');
    } finally {
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`csp-report:ip:${hashBucketComponent(ip)}`]);
      await db.query("DELETE FROM csp_reports WHERE document_host = 'clubika.com'");
    }
  });
});
