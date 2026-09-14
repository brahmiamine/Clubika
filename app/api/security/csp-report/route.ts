import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  checkCapabilityIpRateLimit,
  recordCapabilityIpAttempt,
} from '@/lib/auth/capability-rate-limit';
import { sanitizeCspReport } from '@/lib/security/csp';

const RATE_LIMIT_KEY = 'csp-report';
const RETENTION_DAYS = 7;

function emptyAck(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    const limited = await checkCapabilityIpRateLimit(db, request, RATE_LIMIT_KEY);
    if (limited) return limited;
    await recordCapabilityIpAttempt(db, request, RATE_LIMIT_KEY);

    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      return emptyAck();
    }

    const sanitized = sanitizeCspReport(body);
    if (!sanitized) return emptyAck();

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await db.query('DELETE FROM csp_reports WHERE created_at < ?', [cutoff]);
    await db.query(
      `INSERT INTO csp_reports (document_host, blocked_host, violated_directive, disposition)
       VALUES (?, ?, ?, ?)`,
      [sanitized.documentHost, sanitized.blockedHost, sanitized.violatedDirective, sanitized.disposition],
    );
    return emptyAck();
  } catch {
    return emptyAck();
  }
}
