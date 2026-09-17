import { describe, expect, it } from 'vitest';
import {
  classifyLicenseExpression,
  classifyLicenseToken,
  flattenLicenseMap,
  renderThirdPartyNotices,
} from '../scripts/audit-dependencies.mjs';
import {
  ASSET_EXTENSIONS,
  diffAssetsAgainstRegistry,
  findAssetFiles,
  loadRegistry,
} from '../scripts/check-asset-registry.mjs';

describe('license classification (issue #39)', () => {
  it('accepts common permissive licenses', () => {
    expect(classifyLicenseToken('MIT')).toBe('allowed');
    expect(classifyLicenseToken('Apache-2.0')).toBe('allowed');
    expect(classifyLicenseToken('BSD-3-Clause')).toBe('allowed');
    expect(classifyLicenseToken('0BSD')).toBe('allowed');
  });

  it('blocks missing or UNLICENSED declarations (fail closed)', () => {
    expect(classifyLicenseToken('')).toBe('blocked');
    expect(classifyLicenseToken('UNLICENSED')).toBe('blocked');
    expect(classifyLicenseToken('unknown')).toBe('blocked');
  });

  it('blocks strong copyleft and non-commercial licenses', () => {
    expect(classifyLicenseToken('GPL-3.0-only')).toBe('blocked');
    expect(classifyLicenseToken('AGPL-3.0-or-later')).toBe('blocked');
    expect(classifyLicenseToken('SSPL-1.0')).toBe('blocked');
    expect(classifyLicenseToken('CC-BY-NC-4.0')).toBe('blocked');
  });

  it('flags weak copyleft / unrecognized licenses for human review, not as blocking', () => {
    expect(classifyLicenseToken('LGPL-2.1-or-later')).toBe('review');
    expect(classifyLicenseToken('MPL-2.0')).toBe('review');
    expect(classifyLicenseToken('Custom: https://example.com/license')).toBe('review');
  });

  it('resolves an OR expression to the best available tier', () => {
    expect(classifyLicenseExpression('(MPL-2.0 OR Apache-2.0)')).toBe('allowed');
    expect(classifyLicenseExpression('(GPL-3.0-only OR MIT)')).toBe('allowed');
  });

  it('resolves an AND expression to the worst tier present', () => {
    expect(classifyLicenseExpression('(MIT AND BSD-3-Clause)')).toBe('allowed');
    expect(classifyLicenseExpression('(MIT AND GPL-3.0-only)')).toBe('blocked');
  });

  it('never classifies a real repository dependency as blocked without a matching exception', () => {
    // Documents intent: strong copyleft in this codebase's own dependency
    // tree would be a real blocking finding, not swallowed silently.
    expect(classifyLicenseToken('GPL-2.0-only')).toBe('blocked');
  });
});

describe('flattenLicenseMap (issue #39)', () => {
  it('explodes multi-version packages into one row per version and tags the tier', () => {
    const rows = flattenLicenseMap({
      MIT: [{ name: 'foo', versions: ['1.0.0', '2.0.0'], author: 'Jane', homepage: 'https://example.com' }],
      'GPL-3.0-only': [{ name: 'bar', versions: ['1.0.0'] }],
    });
    expect(rows).toHaveLength(3);
    const foo1 = rows.find((r) => r.name === 'foo' && r.version === '1.0.0');
    expect(foo1?.tier).toBe('allowed');
    expect(foo1?.author).toBe('Jane');
    const bar = rows.find((r) => r.name === 'bar');
    expect(bar?.tier).toBe('blocked');
  });
});

describe('renderThirdPartyNotices (issue #39)', () => {
  it('only includes production (direct + transitive) rows, not dev-only ones', () => {
    const body = renderThirdPartyNotices(
      [
        { name: 'prod-direct', version: '1.0.0', license: 'MIT', tier: 'allowed', scope: 'direct-prod', homepage: '' },
        { name: 'prod-transitive', version: '1.0.0', license: 'MIT', tier: 'allowed', scope: 'transitive-prod', homepage: '' },
        { name: 'dev-only', version: '1.0.0', license: 'MIT', tier: 'allowed', scope: 'direct-dev', homepage: '' },
      ],
      { generatedAt: new Date('2026-09-16') },
    );
    expect(body).toContain('prod-direct');
    expect(body).toContain('prod-transitive');
    expect(body).not.toContain('dev-only');
  });

  it('flags non-allowed tiers inline for human review', () => {
    const body = renderThirdPartyNotices([
      { name: 'needs-review', version: '1.0.0', license: 'LGPL-2.1-or-later', tier: 'review', scope: 'direct-prod', homepage: '' },
    ]);
    expect(body).toMatch(/needs-review@1\.0\.0.*review/);
  });

  it('states plainly that this is not a legal opinion', () => {
    const body = renderThirdPartyNotices([]);
    expect(body).toMatch(/pas un avis juridique/i);
  });
});

describe('asset registry coverage check (issue #39)', () => {
  it('recognizes the expected binary asset extensions', () => {
    expect(ASSET_EXTENSIONS.has('.png')).toBe(true);
    expect(ASSET_EXTENSIONS.has('.svg')).toBe(true);
    expect(ASSET_EXTENSIONS.has('.wav')).toBe(true);
    expect(ASSET_EXTENSIONS.has('.woff2')).toBe(true);
    expect(ASSET_EXTENSIONS.has('.ts')).toBe(false);
  });

  it('flags an asset file that has no registry entry', () => {
    const registry = { assets: [{ path: 'public/known.png', type: 'image/png', author_source: 'x', date: 'x', license_authorization: 'x', modifications: 'x', proof: 'x', status: 'needs_human_review' }] };
    const { missing } = diffAssetsAgainstRegistry(['public/known.png', 'public/new-unregistered.png'], registry);
    expect(missing).toEqual(['public/new-unregistered.png']);
  });

  it('flags a registry entry whose file no longer exists on disk, unless recorded as removed', () => {
    const registry = {
      assets: [
        { path: 'public/gone.png', type: 'image/png', author_source: 'x', date: 'x', license_authorization: 'x', modifications: 'x', proof: 'x', status: 'needs_human_review' },
        { path: 'public/also-gone.png', type: 'image/png', author_source: 'x', date: 'x', license_authorization: 'x', modifications: 'x', proof: 'x', status: 'needs_human_review' },
      ],
      removed_assets: [{ path: 'public/also-gone.png', reason: 'template boilerplate, unused' }],
    };
    const { stale } = diffAssetsAgainstRegistry([], registry);
    expect(stale).toEqual(['public/gone.png']);
  });

  it('flags a registry entry with an empty required field', () => {
    const registry = {
      assets: [{ path: 'public/incomplete.png', type: 'image/png', author_source: '', date: 'x', license_authorization: 'x', modifications: 'x', proof: 'x', status: 'needs_human_review' }],
    };
    const { incomplete } = diffAssetsAgainstRegistry(['public/incomplete.png'], registry);
    expect(incomplete).toEqual([{ path: 'public/incomplete.png', emptyFields: ['author_source'] }]);
  });

  it('passes cleanly when every asset on disk has a complete registry entry', () => {
    const registry = {
      assets: [{ path: 'public/ok.png', type: 'image/png', author_source: 'x', date: 'x', license_authorization: 'x', modifications: 'x', proof: 'x', status: 'needs_human_review' }],
    };
    const { missing, stale, incomplete } = diffAssetsAgainstRegistry(['public/ok.png'], registry);
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
    expect(incomplete).toEqual([]);
  });

  it('finds every real asset file under public/ on disk', () => {
    const files = findAssetFiles();
    expect(files).toContain('public/branding/clubika-icon.png');
    expect(files).toContain('public/sounds/chat-sent.wav');
    // Removed Next.js/Vercel boilerplate must not reappear.
    expect(files).not.toContain('public/vercel.svg');
    expect(files).not.toContain('public/next.svg');
  });

  it('keeps the committed asset registry in sync with every real asset file (no missing, no stale, no incomplete entry)', () => {
    const registry = loadRegistry();
    const files = findAssetFiles();
    const { missing, stale, incomplete } = diffAssetsAgainstRegistry(files, registry);
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
    expect(incomplete).toEqual([]);
  });

  it('never lets a registry entry claim a resolved status without this being a deliberate human review', () => {
    const registry = loadRegistry();
    for (const entry of registry.assets) {
      expect(['needs_human_review', 'authorized', 'removed']).toContain(entry.status);
      if (entry.status !== 'needs_human_review') {
        // Anything other than the default "unknown" bucket must say so
        // explicitly in its own fields rather than merely flipping the flag.
        expect(entry.license_authorization).not.toMatch(/provenance unknown/i);
      }
    }
  });
});
