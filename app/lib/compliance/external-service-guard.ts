import { NextResponse } from 'next/server';
import {
  type ExternalServiceId,
  isExternalServiceEnabled,
} from './external-services';

export function externalServiceGuard(id: ExternalServiceId): NextResponse | null {
  if (isExternalServiceEnabled(id)) return null;
  return NextResponse.json(
    { error: 'Cette intégration est désactivée.', service: id },
    { status: 409 },
  );
}
