import { NextResponse } from 'next/server';

/** Liveness : le processus HTTP répond. Aucune I/O, aucun secret, aucun tenant. */
export async function GET() {
  return NextResponse.json(
    { status: 'live' },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
