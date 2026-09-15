import { NextResponse } from 'next/server';
import { pingDatabaseForReadiness } from '@/lib/db/readiness';

/**
 * Readiness : MariaDB joignable et journal des migrations présent.
 * Aucun tenant créé. Le corps d'erreur ne contient pas le détail SQL.
 */
export async function GET() {
  try {
    const ready = await pingDatabaseForReadiness();
    if (!ready) {
      return NextResponse.json(
        { status: 'not-ready' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json(
      { status: 'ready' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'not-ready' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
