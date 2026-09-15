import 'reflect-metadata';

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (process.env.ALLOW_TEST_NETWORK === 'true') {
    return originalFetch(input as never, init);
  }
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  let origin = raw;
  try {
    origin = new URL(raw, 'http://127.0.0.1').origin;
  } catch {
    origin = 'invalid-url';
  }
  if (origin === 'http://127.0.0.1' || origin === 'http://localhost' || origin === 'https://localhost') {
    return originalFetch(input as never, init);
  }
  throw new Error(`Blocked external fetch in tests: ${origin}`);
}) as typeof fetch;

if (process.env.REQUIRE_DB_TESTS === '1') {
  const { isDbAvailable } = await import('./app/lib/db/test-utils');
  await isDbAvailable();
}
