#!/usr/bin/env node
/**
 * Audit des dépendances de production (issue #37).
 * Seuil bloquant : high + critical. Base = registre npm / advisory GitHub via pnpm.
 * Un registre injoignable ou un JSON illisible échoue (pas de skip silencieux).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadExceptions(path = join(ROOT, 'security/exceptions.json')) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.exceptions)) {
    throw new Error('security/exceptions.json : "exceptions" doit être un tableau (pas de suppression globale).');
  }
  return parsed;
}

export function assertExceptionsFresh(config, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  for (const item of config.exceptions) {
    if (!item.id || !item.reason || !item.compensation || !item.expires) {
      throw new Error(`Exception incomplète (id, reason, compensation, expires requis) : ${JSON.stringify(item)}`);
    }
    if (item.expires < today) {
      throw new Error(`Exception expirée ${item.id} (expires ${item.expires}) — corriger ou renouveler avec justification.`);
    }
  }
}

export function advisoryIds(advisory) {
  const ids = [];
  if (advisory.github_advisory_id) ids.push(advisory.github_advisory_id);
  if (typeof advisory.url === 'string') {
    const match = advisory.url.match(/GHSA-[0-9a-z-]+/i);
    if (match) ids.push(match[0]);
  }
  if (advisory.title) ids.push(String(advisory.id ?? ''));
  return ids.filter(Boolean);
}

export function blockingFindings(audit, config, now = new Date()) {
  assertExceptionsFresh(config, now);
  const block = new Set((config.blockSeverities ?? ['high', 'critical']).map((s) => s.toLowerCase()));
  const allowed = new Set(config.exceptions.map((item) => item.id));
  const hits = [];
  for (const advisory of Object.values(audit.advisories ?? {})) {
    const severity = String(advisory.severity ?? '').toLowerCase();
    if (!block.has(severity)) continue;
    const ids = advisoryIds(advisory);
    if (ids.some((id) => allowed.has(id))) continue;
    hits.push({
      severity,
      module: advisory.module_name,
      title: advisory.title,
      ids,
    });
  }
  return hits;
}

function runAudit() {
  const result = spawnSync('pnpm', ['audit', '--prod', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    console.error('[audit:deps] Scanner indisponible :', result.error.message);
    process.exit(2);
  }
  const raw = (result.stdout || '').trim();
  if (!raw) {
    console.error('[audit:deps] pnpm audit n’a renvoyé aucun JSON (registre injoignable ?).');
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[audit:deps] JSON audit illisible — échec fermé.');
    process.exit(2);
  }
  if (!parsed.metadata || !parsed.advisories) {
    console.error('[audit:deps] Structure audit inattendue — échec fermé.');
    process.exit(2);
  }
  return parsed;
}

if (process.argv[1]?.endsWith('audit-dependencies.mjs')) {
  const config = loadExceptions();
  const audit = runAudit();
  const hits = blockingFindings(audit, config);
  const meta = audit.metadata.vulnerabilities ?? {};
  console.log(
    `Audit production : critical=${meta.critical ?? 0} high=${meta.high ?? 0} moderate=${meta.moderate ?? 0} low=${meta.low ?? 0}`,
  );
  if (hits.length) {
    console.error('[audit:deps] Vulnérabilités bloquantes sans exception valide :');
    for (const hit of hits) {
      console.error(`  - ${hit.severity} ${hit.module} ${hit.ids.join(', ')} ${hit.title}`);
    }
    process.exit(1);
  }
  console.log('Seuil high/critical respecté.');
}
