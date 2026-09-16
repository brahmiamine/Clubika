import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertExceptionsFresh, blockingFindings, loadExceptions } from '../scripts/audit-dependencies.mjs';
import { findUnpinnedUses } from '../scripts/check-action-pins.mjs';
import { renderTrivyIgnore } from '../scripts/generate-trivy-ignore.mjs';

describe('audit exceptions (issue #37)', () => {
  it('rejects a global missing exceptions array', () => {
    expect(() => assertExceptionsFresh({ exceptions: undefined })).toThrow();
  });

  it('rejects an expired exception', () => {
    expect(() => assertExceptionsFresh({
      exceptions: [{
        id: 'GHSA-test-expired',
        reason: 'test',
        compensation: 'test',
        expires: '2020-01-01',
      }],
    }, new Date('2026-09-15'))).toThrow(/expirée/);
  });

  it('accepts a dated, justified exception', () => {
    expect(() => assertExceptionsFresh({
      exceptions: [{
        id: 'GHSA-aaaa-bbbb-cccc',
        reason: 'transitive via jspdf',
        compensation: 'PDF fields only',
        expires: '2026-12-31',
      }],
    }, new Date('2026-09-15'))).not.toThrow();
  });

  it('blocks high findings without a matching exception', () => {
    const hits = blockingFindings({
      advisories: {
        '1': {
          severity: 'high',
          module_name: 'left-pad',
          title: 'example',
          github_advisory_id: 'GHSA-1111-2222-3333',
        },
      },
    }, { blockSeverities: ['high', 'critical'], exceptions: [] });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ids).toContain('GHSA-1111-2222-3333');
  });

  it('keeps committed exceptions named, compensated, and unexpired', () => {
    const config = loadExceptions();
    expect(() => assertExceptionsFresh(config, new Date('2026-09-15'))).not.toThrow();
    for (const item of config.exceptions) {
      expect(item.id).toMatch(/^(GHSA-[0-9a-z-]+|CVE-\d{4}-\d+)$/i);
      expect(item.reason.length).toBeGreaterThan(20);
      expect(item.compensation.length).toBeGreaterThan(20);
      expect(item.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['pnpm-audit', 'trivy-image-os']).toContain(item.scanner);
    }
  });

  it('does not block a high finding covered by a live exception', () => {
    const hits = blockingFindings({
      advisories: {
        '1': {
          severity: 'high',
          module_name: 'left-pad',
          title: 'example',
          github_advisory_id: 'GHSA-1111-2222-3333',
        },
      },
    }, {
      blockSeverities: ['high', 'critical'],
      exceptions: [{
        id: 'GHSA-1111-2222-3333',
        reason: 'test',
        compensation: 'test',
        expires: '2026-12-31',
      }],
    });
    expect(hits).toHaveLength(0);
  });
});

describe('Trivy image OS exceptions (issue #37)', () => {
  it('emits only trivy-image-os CVE ids into the generated ignore file', () => {
    const body = renderTrivyIgnore([
      {
        id: 'CVE-2026-33845',
        scanner: 'trivy-image-os',
        reason: 'vendor base',
        compensation: 'openssl',
        expires: '2026-10-15',
      },
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        scanner: 'pnpm-audit',
        reason: 'npm',
        compensation: 'n/a',
        expires: '2026-12-31',
      },
    ], 'trivy-image-os');
    expect(body).toContain('CVE-2026-33845');
    expect(body).not.toContain('GHSA-aaaa-bbbb-cccc');
  });

  it('covers the current vendor GnuTLS CRITICAL CVEs until the Node image updates', () => {
    const config = loadExceptions();
    const body = renderTrivyIgnore(config.exceptions, 'trivy-image-os');
    expect(body).toContain('CVE-2026-33845');
    expect(body).toContain('CVE-2026-42010');
  });
});

describe('GitHub Action pins (issue #37)', () => {
  it('flags a floating tag and accepts a SHA', () => {
    const sample = `
jobs:
  a:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
`;
    const hits = findUnpinnedUses(sample);
    expect(hits.map((h) => h.ref)).toEqual(['actions/checkout@v4']);
  });

  it('scans the locked NODE_IMAGE, not the Dockerfile ARG placeholder', () => {
    const workflow = readFileSync('.github/workflows/supply-chain.yml', 'utf8');
    expect(workflow).toContain('deploy/runtime-images.lock');
    expect(workflow).not.toMatch(/awk '\/\^FROM \//);
  });
});
