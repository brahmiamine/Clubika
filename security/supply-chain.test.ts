import { describe, expect, it } from 'vitest';
import { assertExceptionsFresh, blockingFindings } from '../scripts/audit-dependencies.mjs';
import { findUnpinnedUses } from '../scripts/check-action-pins.mjs';

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
});
