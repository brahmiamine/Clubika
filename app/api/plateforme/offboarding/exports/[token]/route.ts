import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { OffboardingError } from '@/lib/tenant-offboarding/errors';
import { consumeExport } from '@/lib/tenant-offboarding/export';
import { logError } from '@/lib/observability/log';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;
  try {
    const { token } = params instanceof Promise ? await params : params;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      return NextResponse.json({ error: 'Jeton invalide' }, { status: 400 });
    }
    const db = await getDb();
    const result = await consumeExport(db, token);
    return new NextResponse(result.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="restitution-${result.clubId}.json"`,
        'Cache-Control': 'private, no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        'X-Manifest-SHA256': result.manifestSha256,
      },
    });
  } catch (error) {
    if (error instanceof OffboardingError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logError('app.unhandled', 'tenant export download error:', error);
    return NextResponse.json({ error: 'Impossible de télécharger l’export' }, { status: 500 });
  }
}
