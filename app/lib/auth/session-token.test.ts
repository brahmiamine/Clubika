import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  hashSessionToken,
  isPlausibleSessionToken,
  sessionTokenHashesEqual,
} from './session-token';

describe('session-token (issue #29)', () => {
  it('emits a 64-hex token that is not equal to its HMAC', () => {
    const token = generateSessionToken();
    expect(isPlausibleSessionToken(token)).toBe(true);
    expect(hashSessionToken(token)).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(hashSessionToken(token)).not.toBe(token);
  });

  it('compares hashes in constant time and rejects a mismatch', () => {
    const token = generateSessionToken();
    const digest = hashSessionToken(token);
    expect(sessionTokenHashesEqual(digest, hashSessionToken(token))).toBe(true);
    expect(sessionTokenHashesEqual(digest, hashSessionToken(generateSessionToken()))).toBe(false);
  });
});
