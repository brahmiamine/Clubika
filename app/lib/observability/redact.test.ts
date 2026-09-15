import { describe, expect, it } from 'vitest';
import { classifyProviderError, REDACTED, redact, serializeOutboxError } from './redact';
import { logError } from './log';

const SENTINEL_EMAIL = 'sentinel.user@example.test';
const SENTINEL_TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature';
const SENTINEL_URL = 'https://push.example.test/endpoint?token=super-secret-token';
const SENTINEL_IP = '203.0.113.50';

describe('redact (issue #31)', () => {
  it('strips emails, tokens, IPs, phones and sensitive keys recursively', () => {
    const redacted = redact({
      authorization: 'Bearer abc',
      cookie: 'session=abc',
      nested: {
        email: SENTINEL_EMAIL,
        phone: '+33123456789',
        ip: SENTINEL_IP,
        endpoint: SENTINEL_URL,
        payload: { text: 'should not appear' },
        token: SENTINEL_TOKEN,
        ok: true,
      },
    });
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(SENTINEL_EMAIL);
    expect(json).not.toContain(SENTINEL_TOKEN);
    expect(json).not.toContain('super-secret-token');
    expect(json).not.toContain(SENTINEL_IP);
    expect(json).not.toContain('+33123456789');
    expect(json).not.toContain('should not appear');
    expect((redacted as { authorization: string }).authorization).toBe(REDACTED);
  });

  it('never keeps Error.message (provider text) and maps a code instead', () => {
    const error = new Error(`SMTP failed for ${SENTINEL_EMAIL} at ${SENTINEL_URL}`);
    error.cause = { body: { to: SENTINEL_EMAIL } };
    const redacted = redact(error) as { code: string; retryable: boolean };
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(SENTINEL_EMAIL);
    expect(json).not.toContain('super-secret-token');
    expect(redacted.code).toBe('smtp_failed');
    expect(redacted.retryable).toBe(true);
    expect(json).not.toContain('SMTP failed');
  });

  it('stores only code + retryable in outbox last_error', () => {
    const stored = serializeOutboxError(new Error(`cannot send to ${SENTINEL_EMAIL}`));
    expect(stored).toBe(JSON.stringify({ code: 'unknown', retryable: false }));
    expect(stored).not.toContain(SENTINEL_EMAIL);
  });

  it('does not write sentinels to stdout/stderr', () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      logError('smtp.send_failed', new Error(`mail ${SENTINEL_EMAIL}`), { endpoint: SENTINEL_URL });
    } finally {
      process.stderr.write = original;
    }
    const output = chunks.join('');
    expect(output).toContain('"event":"smtp.send_failed"');
    expect(output).not.toContain(SENTINEL_EMAIL);
    expect(output).not.toContain('super-secret-token');
  });
});

describe('classifyProviderError', () => {
  it('marks timeouts as retryable', () => {
    expect(classifyProviderError(Object.assign(new Error('timeout'), { name: 'AbortError' }))).toEqual({
      code: 'timeout',
      retryable: true,
    });
  });
});
