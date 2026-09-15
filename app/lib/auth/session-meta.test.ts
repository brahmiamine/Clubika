import { describe, expect, it } from 'vitest';
import { coarseClientHint, networkHint } from './session-meta';

describe('session-meta (issue #29)', () => {
  it('keeps only a browser family', () => {
    expect(coarseClientHint('Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36')).toBe('Chrome');
    expect(coarseClientHint('Mozilla/5.0 Firefox/128.0')).toBe('Firefox');
    expect(coarseClientHint(null)).toBeNull();
  });

  it('does not echo the raw IP', () => {
    const hint = networkHint('203.0.113.44');
    expect(hint).toMatch(/^[a-f0-9]{12}$/);
    expect(hint).not.toContain('203');
  });
});
