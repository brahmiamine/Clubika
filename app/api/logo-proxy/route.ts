import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import net from 'node:net';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import {
  ExternalServiceBlockedError,
  assertExternalUrlAllowed,
  isExternalServiceEnabled,
} from '@/lib/compliance/external-services';

/**
 * Proxy d'images même-origine, utilisé pour la carte de partage d'un match : les
 * logos des clubs proviennent de serveurs distants sans en-têtes CORS, ce qui
 * empêche de les dessiner dans un `<canvas>` (`crossOrigin = "anonymous"` échoue).
 * Le proxy récupère l'image côté serveur et la renvoie depuis notre origine.
 *
 * Garde-fous SSRF (issue #272) : session authentifiée requise (le format de cookie
 * seul, vérifié par `proxy.ts`, ne suffit pas) ; résolution DNS explicite puis
 * connexion épinglée à l'adresse IP validée (jamais une seconde résolution au
 * moment de la connexion — élimine le rebinding DNS) ; adresses privées, loopback,
 * lien-local, réservées et de service de métadonnées rejetées ; redirections
 * suivies manuellement (chaque saut revalidé) plutôt qu'automatiquement ; réponse
 * lue en flux avec plafond d'octets strict, jamais bufferisée intégralement avant
 * vérification ; type `image/*` obligatoire ; délai court.
 */

const MAX_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

class SsrfBlockedError extends Error {}
class UpstreamStatusError extends Error {
  constructor(public readonly status: number) {
    super(`Amont ${status}`);
  }
}
class InvalidContentTypeError extends Error {}
class TooLargeError extends Error {}

/** IPv4 (a.b.c.d, déjà découpé) appartenant à une plage privée, réservée ou de service. */
function isDisallowedIpv4(a: number, b: number, c: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // lien-local, inclut le service de métadonnées 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // réservé
  if (a === 192 && b === 0 && c === 2) return true; // documentation (TEST-NET-1)
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // banc d'essai
  if (a === 198 && b === 51 && c === 100) return true; // documentation (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // documentation (TEST-NET-3)
  if (a >= 224) return true; // multicast (224-239), réservé (240-255), diffusion 255.255.255.255
  return false;
}

function isDisallowedIp(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    return isDisallowedIpv4(parts[0]!, parts[1]!, parts[2]!);
  }
  if (family === 6) {
    if (address === '::1' || address === '::') return true; // loopback / non spécifiée
    // Adresses IPv4 mappées en IPv6 : soit en notation décimale pointée
    // (::ffff:127.0.0.1), soit dans la forme canonique à groupes hexadécimaux que
    // renvoient le module `url` ou `net.isIP` (::ffff:7f00:1 pour 127.0.0.1).
    const mappedDotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) return isDisallowedIp(mappedDotted[1]!);
    const mappedHex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isDisallowedIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // lien-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // unique locale fc00::/7
    if (address.startsWith('ff')) return true; // multicast ff00::/8
    return false;
  }
  return true; // ni IPv4 ni IPv6 : jamais une adresse de connexion valide
}

/**
 * Résout le nom d'hôte une seule fois et choisit une adresse validée : la connexion
 * se fera exclusivement vers cette adresse littérale (jamais une nouvelle résolution
 * DNS au moment du `connect`), ce qui élimine le rebinding DNS entre validation et
 * connexion.
 */
async function resolveValidatedAddress(hostname: string): Promise<string> {
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(bareHost);
  const candidates = literalFamily
    ? [{ address: bareHost, family: literalFamily }]
    : await dns.lookup(bareHost, { all: true, verbatim: true }).catch(() => []);
  const valid = candidates.find((candidate) => !isDisallowedIp(candidate.address));
  if (!valid) throw new SsrfBlockedError('Hôte non autorisé');
  return valid.address;
}

interface UpstreamResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

function performRequest(target: URL, ip: string): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const requester = isHttps ? https.request : http.request;
    const req = requester({
      hostname: ip,
      port: target.port ? Number(target.port) : (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        Host: target.host,
        Accept: 'image/*',
        'User-Agent': 'Clubika/1.0 (+logo-proxy)',
      },
      // SNI + vérification du certificat sur le nom d'hôte d'origine, jamais sur
      // l'adresse IP épinglée (ignoré par http.request pour les cibles http:).
      servername: isHttps ? target.hostname : undefined,
      rejectUnauthorized: true,
      timeout: FETCH_TIMEOUT_MS,
    } as https.RequestOptions, (res) => {
      resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: res });
    });
    req.on('timeout', () => req.destroy(new Error('Délai dépassé')));
    req.on('error', reject);
    req.end();
  });
}

/** Lit le corps en flux, en interrompant la connexion dès que le plafond est dépassé. */
function readBodyWithLimit(body: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    body.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        body.destroy();
        reject(new TooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    body.on('end', () => resolve(Buffer.concat(chunks)));
    body.on('error', reject);
  });
}

async function fetchImageSafely(initialUrl: URL): Promise<{ contentType: string; buffer: Buffer }> {
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (currentUrl.protocol !== 'https:' && currentUrl.protocol !== 'http:') {
      throw new SsrfBlockedError('Protocole non autorisé');
    }
    const ip = await resolveValidatedAddress(currentUrl.hostname);
    const { statusCode, headers, body } = await performRequest(currentUrl, ip);

    if (statusCode >= 300 && statusCode < 400 && headers.location) {
      body.destroy();
      // Chaque saut de redirection est revalidé depuis zéro (protocole, résolution,
      // plage IP) : une redirection ne peut pas contourner les garde-fous ci-dessus.
      currentUrl = new URL(headers.location, currentUrl);
      continue;
    }
    if (statusCode !== 200) {
      body.destroy();
      throw new UpstreamStatusError(statusCode);
    }
    const contentType = headers['content-type'] ?? '';
    if (!/^image\//i.test(contentType)) {
      body.destroy();
      throw new InvalidContentTypeError();
    }
    const buffer = await readBodyWithLimit(body);
    return { contentType, buffer };
  }
  throw new SsrfBlockedError('Trop de redirections');
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;

  if (!isExternalServiceEnabled('logo-proxy')) {
    return NextResponse.json({ error: 'Cette intégration est désactivée.', service: 'logo-proxy' }, { status: 409 });
  }

  const raw = request.nextUrl.searchParams.get('url');
  if (!raw) return NextResponse.json({ error: 'Paramètre url manquant' }, { status: 400 });

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: 'URL invalide' }, { status: 400 });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return NextResponse.json({ error: 'Protocole non autorisé' }, { status: 400 });
  }
  try {
    assertExternalUrlAllowed('logo-proxy', target.toString());
  } catch (error) {
    if (error instanceof ExternalServiceBlockedError) {
      return NextResponse.json({ error: 'Hôte non autorisé' }, { status: 400 });
    }
    throw error;
  }

  try {
    const { contentType, buffer } = await fetchImageSafely(target);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      return NextResponse.json({ error: 'Hôte non autorisé' }, { status: 400 });
    }
    if (error instanceof InvalidContentTypeError) {
      return NextResponse.json({ error: 'La ressource distante n’est pas une image' }, { status: 415 });
    }
    if (error instanceof TooLargeError) {
      return NextResponse.json({ error: 'Image trop volumineuse' }, { status: 413 });
    }
    if (error instanceof UpstreamStatusError) {
      return NextResponse.json({ error: `Amont ${error.status}` }, { status: 502 });
    }
    console.error('logo-proxy failed:', error);
    return NextResponse.json({ error: 'Récupération de l’image impossible' }, { status: 502 });
  }
}
