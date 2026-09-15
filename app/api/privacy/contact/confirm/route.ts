import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { confirmEmailChange } from '@/lib/privacy/rectify';
import { checkCapabilityIpRateLimit, recordCapabilityIpAttempt } from '@/lib/auth/capability-rate-limit';

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    const blocked = await checkCapabilityIpRateLimit(db, request, 'privacy-email-confirm');
    if (blocked) return blocked;
    await recordCapabilityIpAttempt(db, request, 'privacy-email-confirm');

    const body = await request.json();
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return NextResponse.json({ error: 'Jeton requis' }, { status: 400 });
    try {
      await confirmEmailChange(db, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Confirmation impossible';
      const conflict = message.includes('déjà utilisé');
      const expired = message.includes('expiré') || message.includes('invalide');
      return NextResponse.json({ error: message }, { status: conflict ? 409 : expired ? 410 : 400 });
    }
    return NextResponse.json({ success: true, reconnectRequired: true });
  } catch (error) {
    console.error('Email confirm failed:', error);
    return NextResponse.json({ error: 'Confirmation impossible' }, { status: 500 });
  }
}
