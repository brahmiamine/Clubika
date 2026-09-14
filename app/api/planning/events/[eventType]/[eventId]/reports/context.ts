import { NextResponse } from 'next/server';
import { REPORT_KIND } from '@/lib/planning/report-access';

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

export function reportJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function reportNotFound(): NextResponse {
  return reportJson({ error: 'Not found' }, 404);
}

export function isReportRecordId(id: string): boolean {
  return id.startsWith(`${REPORT_KIND}:`);
}
