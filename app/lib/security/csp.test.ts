import { describe, expect, it } from 'vitest';
import { buildCspReportOnly, sanitizeCspReport } from './csp';

describe('CSP report-only (issue #35)', () => {
  it('pose default-src self, un nonce script et les directives de cadrage', () => {
    const policy = buildCspReportOnly('test-nonce');
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain('upgrade-insecure-requests');
    expect(policy).toContain('report-uri /api/security/csp-report');
  });

  it('ne conserve que l’hôte et la directive, jamais l’URI ni un jeton', () => {
    const sanitized = sanitizeCspReport({
      'csp-report': {
        'document-uri': 'https://clubika.com/club/invitations?token=secret-value',
        referrer: 'https://evil.example/steal?cookie=abc',
        'blocked-uri': 'https://cdn.evil/x.js?session=tok_live_123',
        'violated-directive': "script-src 'self'",
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
  });
});
