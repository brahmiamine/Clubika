#!/usr/bin/env node
/**
 * Refuse les workflows qui référencent une Action par tag flottant (issue #37).
 * Format attendu : uses: owner/repo@<40 hex> # vX.Y.Z
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const SHA = /@[0-9a-f]{40}\b/i;

export function findUnpinnedUses(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/uses:\s*([^\s#]+)/);
    if (!match) continue;
    const ref = match[1].trim().replace(/^['"]|['"]$/g, '');
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    if (!SHA.test(ref)) {
      hits.push({ line: i + 1, ref });
    }
  }
  return hits;
}

export function checkWorkflowsDir(dir = WORKFLOWS) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
  const errors = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const hit of findUnpinnedUses(text)) {
      errors.push(`${file}:${hit.line} uses non épinglé : ${hit.ref}`);
    }
  }
  return { files, errors };
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked || process.argv[1]?.endsWith('check-action-pins.mjs')) {
  const { files, errors } = checkWorkflowsDir();
  if (errors.length) {
    console.error('[audit:actions] Actions GitHub non épinglées à un SHA :');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Actions épinglées (${files.length} workflow(s)).`);
}
