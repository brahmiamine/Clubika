import { isIP } from 'node:net';
import { clientIpFromForwardedHeaders, trustProxyHeadersEnabled } from '@/lib/auth/client-ip';

type HeaderValue = string | string[] | undefined;

export function handshakeClientAddress(
  headers: Record<string, HeaderValue>,
  remoteAddress: string | undefined,
  trustProxyHeaders = trustProxyHeadersEnabled(),
): string {
  const fromProxy = clientIpFromForwardedHeaders(
    (name) => headers[name],
    trustProxyHeaders,
  );
  if (fromProxy) return fromProxy;
  if (remoteAddress && isIP(remoteAddress)) return remoteAddress;
  return remoteAddress || 'unknown';
}
