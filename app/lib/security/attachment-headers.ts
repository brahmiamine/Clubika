import { safeFileName } from '@/lib/security/file-inspect';

const INLINE_SAFE = /^(image|video|audio)\//;

export function attachmentDownloadHeaders(input: {
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}): Record<string, string> {
  const inline = INLINE_SAFE.test(input.mimeType);
  const name = safeFileName(input.fileName);
  return {
    'Content-Type': input.mimeType,
    'Content-Length': String(input.sizeBytes),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  };
}
