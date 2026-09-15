/**
 * Rotation enc:v1 → enc:v2 (clé active). Dry-run par défaut.
 *
 *   pnpm exec tsx scripts/rotate-encryption-keys.ts
 *   pnpm exec tsx scripts/rotate-encryption-keys.ts --apply
 */
import { getDataSource } from '../app/lib/db/data-source';
import {
  classifyEnvelope,
  envelopeKeyId,
  needsReencrypt,
  reencryptSecret,
  activeEncryptionKeyId,
  isEncryptionConfigured,
} from '../app/lib/crypto/secret-box';

const APPLY = process.argv.includes('--apply');

interface Bucket {
  plaintext: number;
  encV1: number;
  encV2Current: number;
  encV2Other: number;
  failed: number;
  updated: number;
}

function emptyBucket(): Bucket {
  return { plaintext: 0, encV1: 0, encV2Current: 0, encV2Other: 0, failed: 0, updated: 0 };
}

function tally(bucket: Bucket, stored: string): void {
  const kind = classifyEnvelope(stored);
  if (kind === 'plaintext' || kind === 'escaped') bucket.plaintext += 1;
  else if (kind === 'enc-v1') bucket.encV1 += 1;
  else if (envelopeKeyId(stored) === activeEncryptionKeyId()) bucket.encV2Current += 1;
  else bucket.encV2Other += 1;
}

async function rotateColumn(
  db: Awaited<ReturnType<typeof getDataSource>>,
  label: string,
  selectSql: string,
  updateSql: string,
): Promise<Bucket> {
  const bucket = emptyBucket();
  const rows = await db.query(selectSql) as Array<{ id: string | number; value: string | null }>;
  for (const row of rows) {
    if (row.value == null || row.value === '') continue;
    tally(bucket, row.value);
    if (!APPLY) continue;
    if (!needsReencrypt(row.value)) continue;
    const next = reencryptSecret(row.value);
    if (next === null) {
      bucket.failed += 1;
      continue;
    }
    await db.query(updateSql, [next, row.id]);
    bucket.updated += 1;
  }
  console.log(`[${label}] plaintext=${bucket.plaintext} enc:v1=${bucket.encV1} enc:v2:current=${bucket.encV2Current} enc:v2:other=${bucket.encV2Other} failed=${bucket.failed} updated=${bucket.updated}`);
  return bucket;
}

async function main(): Promise<void> {
  if (!isEncryptionConfigured()) {
    console.error('APP_ENCRYPTION_KEY requis');
    process.exit(1);
  }
  console.log(`Mode : ${APPLY ? 'APPLY' : 'dry-run'} — clé active ${activeEncryptionKeyId()}`);
  const db = await getDataSource();
  try {
    await rotateColumn(
      db,
      'chat_messages.content',
      'SELECT id, content AS value FROM chat_messages WHERE content IS NOT NULL AND content <> \'\'',
      'UPDATE chat_messages SET content = ? WHERE id = ?',
    );
    await rotateColumn(
      db,
      'club_tenants.smtpPasswordEncrypted',
      'SELECT id, smtpPasswordEncrypted AS value FROM club_tenants WHERE smtpPasswordEncrypted IS NOT NULL AND smtpPasswordEncrypted <> \'\'',
      'UPDATE club_tenants SET smtpPasswordEncrypted = ? WHERE id = ?',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
