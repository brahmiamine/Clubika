import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Isolé de route.test.ts (qui vérifie l'authentification réelle contre la base) :
// `vi.mock` est hissé en tête de fichier par Vitest et s'appliquerait à tout le
// fichier, rendant les tests d'authentification réelle inutiles s'ils cohabitaient
// ici. Cette suite ne teste que la logique SSRF, avec authentification et réseau
// mockés — exécutable sans base de données ni accès réseau réel.
vi.mock('@/lib/auth/require', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 1, clubId: 'afp', accessRole: 'admin' } })),
}));

function proxyRequest(url: string) {
  return new NextRequest(`http://localhost/api/logo-proxy?url=${encodeURIComponent(url)}`);
}

class FakeIncomingMessage extends EventEmitter {
  statusCode?: number;
  headers: Record<string, string> = {};
  destroy = vi.fn();
}

class FakeClientRequest extends EventEmitter {
  end = vi.fn();
  // `destroy(error)` sur un vrai ClientRequest Node émet 'error' avec cette erreur ;
  // reproduit ici pour que le handler `req.on('timeout', () => req.destroy(...))`
  // se comporte comme en production.
  destroy = vi.fn((err?: Error) => {
    if (err) queueMicrotask(() => this.emit('error', err));
  });
}

function respondWith(
  requestMock: ReturnType<typeof vi.fn>,
  status: number,
  headers: Record<string, string>,
  chunks: Buffer[],
) {
  requestMock.mockImplementationOnce((_options: unknown, callback: (res: FakeIncomingMessage) => void) => {
    const req = new FakeClientRequest();
    const res = new FakeIncomingMessage();
    res.statusCode = status;
    res.headers = headers;
    queueMicrotask(() => {
      callback(res);
      queueMicrotask(() => {
        for (const chunk of chunks) res.emit('data', chunk);
        res.emit('end');
      });
    });
    return req;
  });
}

function mockPublicDns() {
  vi.doMock('node:dns', () => ({
    promises: { lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) },
  }));
}

describe('GET /api/logo-proxy — garde-fous SSRF (issue #272, sans réseau réel)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv('LOGO_PROXY_ENABLED', 'true');
    vi.stubEnv('LOGO_PROXY_ALLOWED_HOSTS', 'logos.example.com,cdn.example.com');
  });

  const blockedTargets = [
    ['loopback IPv4', 'http://127.0.0.1/logo.png'],
    ['loopback IPv4 (variante)', 'http://127.5.5.5/logo.png'],
    ['privé RFC1918 10.x', 'http://10.1.2.3/logo.png'],
    ['privé RFC1918 172.16.x', 'http://172.16.0.5/logo.png'],
    ['privé RFC1918 192.168.x', 'http://192.168.1.1/logo.png'],
    ['lien-local / service de métadonnées', 'http://169.254.169.254/latest/meta-data/'],
    ['CGNAT 100.64.x', 'http://100.64.0.1/logo.png'],
    ['multicast', 'http://224.0.0.1/logo.png'],
    ['réservé', 'http://240.0.0.1/logo.png'],
    ['loopback IPv6', 'http://[::1]/logo.png'],
    ['non spécifiée IPv6', 'http://[::]/logo.png'],
    ['lien-local IPv6', 'http://[fe80::1]/logo.png'],
    ['unique locale IPv6', 'http://[fc00::1]/logo.png'],
    ['multicast IPv6', 'http://[ff02::1]/logo.png'],
    ['IPv4 mappée en IPv6, loopback', 'http://[::ffff:127.0.0.1]/logo.png'],
  ] as const;

  for (const [label, url] of blockedTargets) {
    it(`rejette une cible ${label}`, async () => {
      const { GET } = await import('./route');
      const response = await GET(proxyRequest(url));
      expect(response.status).toBe(400);
    });
  }

  it('rejette un protocole non http(s)', async () => {
    const { GET } = await import('./route');
    const response = await GET(proxyRequest('ftp://example.com/logo.png'));
    expect(response.status).toBe(400);
  });

  it('rejette une URL absente ou invalide', async () => {
    const { GET } = await import('./route');
    const missing = await GET(new NextRequest('http://localhost/api/logo-proxy'));
    expect(missing.status).toBe(400);
    const invalid = await GET(proxyRequest('pas-une-url'));
    expect(invalid.status).toBe(400);
  });

  it('diffuse une image valide depuis une cible publique', async () => {
    mockPublicDns();
    const httpsRequestMock = vi.fn();
    vi.doMock('node:https', () => ({ request: httpsRequestMock }));
    vi.doMock('node:http', () => ({ request: vi.fn() }));
    respondWith(httpsRequestMock, 200, { 'content-type': 'image/png' }, [Buffer.from('fake-png-bytes')]);

    const { GET } = await import('./route');
    const response = await GET(proxyRequest('https://logos.example.com/club.png'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString()).toBe('fake-png-bytes');
  });

  it('suit une redirection unique en revalidant la nouvelle cible', async () => {
    mockPublicDns();
    const httpsRequestMock = vi.fn();
    vi.doMock('node:https', () => ({ request: httpsRequestMock }));
    vi.doMock('node:http', () => ({ request: vi.fn() }));
    respondWith(httpsRequestMock, 302, { location: 'https://cdn.example.com/club-final.png' }, []);
    respondWith(httpsRequestMock, 200, { 'content-type': 'image/jpeg' }, [Buffer.from('final-image')]);

    const { GET } = await import('./route');
    const response = await GET(proxyRequest('https://logos.example.com/club.png'));
    expect(response.status).toBe(200);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
  });

  it('bloque une redirection vers une cible privée', async () => {
    mockPublicDns();
    const httpsRequestMock = vi.fn();
    vi.doMock('node:https', () => ({ request: httpsRequestMock }));
    vi.doMock('node:http', () => ({ request: vi.fn() }));
    respondWith(httpsRequestMock, 302, { location: 'http://169.254.169.254/latest/meta-data/' }, []);

    const { GET } = await import('./route');
    const response = await GET(proxyRequest('https://logos.example.com/club.png'));
    expect(response.status).toBe(400);
  });

  it('refuse un type de contenu non image', async () => {
    mockPublicDns();
    const httpsRequestMock = vi.fn();
    vi.doMock('node:https', () => ({ request: httpsRequestMock }));
    vi.doMock('node:http', () => ({ request: vi.fn() }));
    respondWith(httpsRequestMock, 200, { 'content-type': 'text/html' }, [Buffer.from('<html></html>')]);

    const { GET } = await import('./route');
    const response = await GET(proxyRequest('https://logos.example.com/club.png'));
    expect(response.status).toBe(415);
  });

  it('interrompt un flux qui dépasse le plafond de taille sans le bufferiser entièrement', async () => {
    mockPublicDns();
    const httpsRequestMock = vi.fn();
    vi.doMock('node:https', () => ({ request: httpsRequestMock }));
    vi.doMock('node:http', () => ({ request: vi.fn() }));
    const oversizedChunk = Buffer.alloc(3 * 1024 * 1024 + 1, 1);
    respondWith(httpsRequestMock, 200, { 'content-type': 'image/png' }, [oversizedChunk]);

    const { GET } = await import('./route');
    const response = await GET(proxyRequest('https://logos.example.com/club.png'));
    expect(response.status).toBe(413);
  });

  it('signale un délai dépassé comme une erreur amont', async () => {
    mockPublicDns();
    const httpsRequestMock = vi.fn().mockImplementationOnce(() => {
      const req = new FakeClientRequest();
      queueMicrotask(() => req.emit('timeout'));
      return req;
    });
    vi.doMock('node:https', () => ({ request: httpsRequestMock }));
    vi.doMock('node:http', () => ({ request: vi.fn() }));

    const { GET } = await import('./route');
    const response = await GET(proxyRequest('https://logos.example.com/club.png'));
    expect(response.status).toBe(502);
  });
});
