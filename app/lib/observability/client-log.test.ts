import { afterEach, describe, expect, it, vi } from 'vitest';

describe('client-log (issue #31)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('never writes names or API bodies in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { logError, logWarn } = await import('./client-log');
    logError('app.unhandled', { email: 'sentinel.user@example.test', body: { name: 'Ada' } });
    logWarn('auth.failed', 'should not appear');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
