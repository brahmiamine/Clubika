import { describe, expect, it } from 'vitest';
import { handshakeClientAddress } from './socket-security';

describe('Socket.IO handshake client address', () => {
  it('uses the proxy-injected client address when trusted proxy headers are enabled', () => {
    expect(
      handshakeClientAddress(
        { 'x-real-ip': '203.0.113.8' },
        '10.0.0.4',
        true,
      ),
    ).toBe('203.0.113.8');
  });

  it('does not trust proxy headers by default', () => {
    expect(handshakeClientAddress({ 'x-real-ip': '203.0.113.8' }, '127.0.0.1', false)).toBe('127.0.0.1');
  });

  it('falls back to the TCP peer when the proxy sends a malformed address', () => {
    expect(handshakeClientAddress({ 'x-real-ip': 'spoofed' }, '10.0.0.4', true)).toBe(
      '10.0.0.4',
    );
  });

  it('uses the trusted hop of X-Forwarded-For and ignores a forged prefix', () => {
    expect(
      handshakeClientAddress(
        { 'x-forwarded-for': '203.0.113.1, 198.51.100.9' },
        '10.0.0.4',
        true,
      ),
    ).toBe('198.51.100.9');
  });
});
