import { logError } from '@/lib/observability/log';
import { NextResponse } from 'next/server';
import { ChatAccessError, ChatValidationError } from './service';

export function chatErrorResponse(error: unknown): NextResponse {
  if (error instanceof ChatAccessError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof ChatValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  logError('app.unhandled', 'Chat request failed:', error);
  return NextResponse.json({ error: 'Le service de chat est momentanément indisponible' }, { status: 500 });
}

export function participantIdsFrom(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0),
    ),
  );
}
