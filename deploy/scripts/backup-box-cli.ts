#!/usr/bin/env node
/**
 * Chiffre / déchiffre un dump gzip sur stdin → stdout (issue #24).
 * Usage :
 *   BACKUP_ENCRYPTION_KEY=… tsx deploy/scripts/backup-box-cli.ts encrypt
 *   BACKUP_ENCRYPTION_KEY=… tsx deploy/scripts/backup-box-cli.ts decrypt
 */
import { decryptBackup, encryptBackup, backupFingerprint } from '../../app/lib/crypto/backup-box';

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const secret = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!secret) {
    console.error('BACKUP_ENCRYPTION_KEY manquant');
    process.exit(1);
  }
  const input = await readStdin();
  if (mode === 'encrypt') {
    const out = encryptBackup(input, secret, process.env.BACKUP_ENCRYPTION_KEY_ID?.trim() || 'b1');
    process.stderr.write(`${backupFingerprint(out)}\n`);
    process.stdout.write(out);
    return;
  }
  if (mode === 'decrypt') {
    process.stdout.write(decryptBackup(input, secret));
    return;
  }
  console.error('Usage : backup-box-cli.ts encrypt|decrypt');
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
