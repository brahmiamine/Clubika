import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { consumeExportDownload } from '@/lib/privacy/download';
import { checkCapabilityIpRateLimit, checkCapabilityTokenRateLimit, recordCapabilityIpAttempt, recordCapabilityTokenAttempt } from '@/lib/auth/capability-rate-limit';
import { logError } from '@/lib/observability/log';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } },
) {
  try {
    const resolved = params instanceof Promise ? await params : params;
    const token = resolved.token?.trim() ?? '';
    if (!token) return NextResponse.json({ error: 'Jeton invalide' }, { status: 400 });

    const db = await getDb();
    const blockedIp = await checkCapabilityIpRateLimit(db, request, 'privacy-export');
    if (blockedIp) return blockedIp;
    const blockedToken = await checkCapabilityTokenRateLimit(db, 'privacy-export', token);
    if (blockedToken) return blockedToken;
    await recordCapabilityIpAttempt(db, request, 'privacy-export');
    await recordCapabilityTokenAttempt(db, 'privacy-export', token);

    const format = new URL(request.url).searchParams.get('format') === 'html' ? 'html' : 'json';
    const result = await consumeExportDownload(db, token, format);
    if ('error' in result) {
      const status = result.error === 'missing' ? 404 : 410;
      return NextResponse.json({ error: 'Lien d’export indisponible' }, { status });
    }
    return new NextResponse(result.body, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="clubika-donnees.${format === 'html' ? 'html' : 'json'}"`,
      },
    });
  } catch (error) {
    logError('app.unhandled', 'Privacy export download failed:', error);
    return NextResponse.json({ error: 'Téléchargement impossible' }, { status: 500 });
  }
}
