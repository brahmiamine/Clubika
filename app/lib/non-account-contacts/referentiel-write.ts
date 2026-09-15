import { NextResponse } from 'next/server';
import type { DataSource, EntityManager } from 'typeorm';
import type { UserEntity } from '@/lib/db/schemas';
import { ContactLifecycleError, type ContactCategory } from './constants';
import {
  assertTelephoneAllowed,
  loadContactMeta,
  normalizeTelephone,
  parseProvenance,
  parsePurpose,
  upsertContactMeta,
} from './meta';

type Queryable = DataSource | EntityManager;

export function contactLifecycleResponse(error: unknown): NextResponse | null {
  if (error instanceof ContactLifecycleError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return null;
}

export async function applyTelephoneGateAndMeta(
  db: Queryable,
  input: {
    user: Pick<UserEntity, 'id' | 'telephone'>;
    clubId: string;
    category: ContactCategory;
    recordedByUserId: number;
    body: Record<string, unknown>;
  },
): Promise<string | null> {
  const provenance = parseProvenance(input.body.provenance);
  const purpose = parsePurpose(input.body.purpose);
  const telephone = Object.prototype.hasOwnProperty.call(input.body, 'telephone')
    ? normalizeTelephone(input.body.telephone)
    : input.user.telephone;
  const existing = await loadContactMeta(db, input.user.id);
  assertTelephoneAllowed({
    telephone,
    previousTelephone: input.user.telephone,
    provenance,
    existingProvenance: existing?.provenance ?? null,
  });
  await upsertContactMeta(db, {
    userId: input.user.id,
    clubId: input.clubId,
    category: input.category,
    provenance,
    purpose,
    recordedByUserId: input.recordedByUserId,
  });
  return telephone;
}
