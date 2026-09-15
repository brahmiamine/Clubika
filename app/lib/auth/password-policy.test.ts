import { describe, expect, it } from 'vitest';
import { evaluatePasswordPolicy, PASSWORD_MIN_LENGTH } from './password-policy';

describe('evaluatePasswordPolicy (issue #32)', () => {
  it('rejects passwords shorter than the length floor', async () => {
    const result = await evaluatePasswordPolicy('short');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it('accepts a long passphrase without complexity rules', async () => {
    const result = await evaluatePasswordPolicy('une longue phrase de passe sans symbole');
    expect(result).toEqual({ ok: true });
  });

  it('rejects a well-known local compromised password even if long enough', async () => {
    const result = await evaluatePasswordPolicy('password1234');
    expect(result.ok).toBe(false);
  });

  it('does not require mixed case or digits', async () => {
    const result = await evaluatePasswordPolicy('correct horse battery staple');
    expect(result).toEqual({ ok: true });
  });
});
