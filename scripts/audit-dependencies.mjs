#!/usr/bin/env node
/**
 * Audit des dépendances de production (issue #37) + inventaire de licences
 * (issue #39, needs:legal-review). Seuil bloquant vulnérabilités : high +
 * critical. Base = registre npm / advisory GitHub via pnpm.
 * Un registre injoignable ou un JSON illisible échoue (pas de skip silencieux).
 *
 * L'inventaire de licences ci-dessous est un outil d'aide, PAS un avis
 * juridique. Aucun agent ne peut certifier qu'une licence ou qu'un actif est
 * "clear" pour un usage commercial. Toute entrée "review"/"blocked" — et en
 * réalité tout le fichier — reste soumise à revue humaine propriété
 * intellectuelle avant commercialisation. Voir docs/compliance/README.md.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPLIANCE_DIR = join(ROOT, 'docs/compliance');
const INVENTORY_PATH = join(COMPLIANCE_DIR, 'dependency-license-inventory.json');
const NOTICES_PATH = join(ROOT, 'THIRD_PARTY_NOTICES.md');

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

// --- Inventaire de licences (issue #39) -----------------------------------
//
// Classement heuristique en 3 niveaux, PAS un avis juridique :
//   allowed : licence permissive répandue (MIT, Apache-2.0, BSD, ISC, ...).
//   review  : copyleft faible / attribution / expression non répertoriée
//             (LGPL, MPL, CC-BY-SA, "Custom: ...", SPDX inconnu) — nécessite
//             une lecture humaine, n'échoue pas la CI à elle seule.
//   blocked : licence absente/« UNLICENSED », copyleft fort réseau/diffusion
//             (GPL/AGPL/SSPL/OSL/CPAL/EUPL) ou non-commerciale (CC-BY-NC) —
//             échoue la CI. Échec fermé : une licence qu'on ne sait pas lire
//             n'est jamais traitée comme "allowed".

export const ALLOWED_LICENSE_TOKENS = new Set([
  'MIT',
  'ISC',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  '0BSD',
  'MIT-0',
  'Apache-2.0',
  'Apache 2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Zlib',
  'WTFPL',
  'Python-2.0',
  'CC-BY-4.0',
]);

const BLOCKED_LICENSE_PATTERNS = [
  /^A?GPL-/i, // GPL-*, AGPL-*
  /^SSPL/i,
  /^OSL-/i,
  /^CPAL-/i,
  /^EUPL-/i,
  /^CC-BY-NC/i,
];

const MISSING_LICENSE_TOKENS = new Set(['', 'UNLICENSED', 'UNKNOWN', 'NONE', 'NOASSERTION']);

export function classifyLicenseToken(token) {
  const value = String(token ?? '').trim();
  if (MISSING_LICENSE_TOKENS.has(value.toUpperCase())) return 'blocked';
  if (BLOCKED_LICENSE_PATTERNS.some((pattern) => pattern.test(value))) return 'blocked';
  if (ALLOWED_LICENSE_TOKENS.has(value)) return 'allowed';
  return 'review';
}

const TIER_RANK = { allowed: 0, review: 1, blocked: 2 };

function tierFromRank(rank) {
  if (rank <= TIER_RANK.allowed) return 'allowed';
  if (rank === TIER_RANK.review) return 'review';
  return 'blocked';
}

/**
 * Découpe une expression SPDX en jetons (parenthèses, opérateurs AND/OR/WITH,
 * identifiants). Un identifiant peut contenir des espaces (ex. « Apache 2.0 ») :
 * on ne coupe donc jamais sur un simple espace, uniquement autour des
 * parenthèses et des opérateurs SPDX reconnus comme mots entiers.
 */
export function tokenizeLicenseExpression(expr) {
  const text = String(expr ?? '');
  const tokens = [];
  let buffer = '';
  let index = 0;
  const flush = () => {
    const value = buffer.trim();
    if (value) tokens.push(value);
    buffer = '';
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '(' || char === ')') {
      flush();
      tokens.push(char);
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      let lookahead = index;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      const operator = text.slice(lookahead).match(/^(AND|OR|WITH)(?=\s|\(|\)|$)/);
      if (operator) {
        flush();
        tokens.push(operator[1]);
        index = lookahead + operator[1].length;
        continue;
      }
      buffer += text.slice(index, lookahead);
      index = lookahead;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return tokens;
}

/**
 * Classe une expression SPDX composée en respectant les parenthèses et la
 * précédence SPDX (AND plus fort que OR). `WITH <exception>` conserve le
 * classement de la licence de base (une exception ne peut pas rendre une
 * licence plus permissive qu'elle ne l'est déjà, donc on ne sur-classe pas vers
 * `allowed` et on garde un copyleft `blocked`). Échec fermé : toute expression
 * illisible, ambiguë ou déséquilibrée est classée `blocked`, jamais `allowed`.
 */
export function classifyLicenseExpression(expr) {
  const raw = String(expr ?? '').trim();
  if (!raw) return classifyLicenseToken('');
  const tokens = tokenizeLicenseExpression(raw);
  let index = 0;

  const peek = () => tokens[index];
  const isOperator = (operator) => typeof peek() === 'string' && peek().toUpperCase() === operator;

  const parsePrimary = () => {
    const token = tokens[index++];
    if (token === undefined) throw new Error('expression SPDX incomplète');
    if (token === '(') {
      const rank = parseOr();
      if (tokens[index++] !== ')') throw new Error('parenthèse SPDX non fermée');
      return rank;
    }
    if (token === ')') throw new Error('parenthèse SPDX inattendue');
    return TIER_RANK[classifyLicenseToken(token)];
  };

  const parseWith = () => {
    const rank = parsePrimary();
    if (isOperator('WITH')) {
      index += 1;
      const exception = tokens[index++];
      if (!exception || exception === '(' || exception === ')') throw new Error('exception SPDX invalide');
    }
    return rank;
  };

  const parseAnd = () => {
    let rank = parseWith();
    while (isOperator('AND')) {
      index += 1;
      rank = Math.max(rank, parseWith());
    }
    return rank;
  };

  const parseOr = () => {
    let rank = parseAnd();
    while (isOperator('OR')) {
      index += 1;
      rank = Math.min(rank, parseAnd());
    }
    return rank;
  };

  try {
    const rank = parseOr();
    if (index !== tokens.length) throw new Error('jetons SPDX inattendus');
    return tierFromRank(rank);
  } catch {
    return 'blocked';
  }
}

function runPnpmLicenses(extraArgs = []) {
  const result = spawnSync('pnpm', ['licenses', 'list', '--json', ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
  });
  if (result.error) {
    console.error('[audit:licenses] `pnpm licenses` indisponible :', result.error.message);
    process.exit(2);
  }
  const raw = (result.stdout || '').trim();
  if (!raw) {
    console.error('[audit:licenses] `pnpm licenses list --json` n’a rien renvoyé.');
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[audit:licenses] JSON illisible — échec fermé.');
    process.exit(2);
  }
  if (parsed && parsed.error) {
    console.error('[audit:licenses] `pnpm licenses` en erreur :', parsed.error.message ?? parsed.error);
    process.exit(2);
  }
  return parsed;
}

/**
 * Comparateur de versions (semver-like, tolérant) : compare numériquement les
 * segments, puis les pré-versions (`1.0.0-alpha` avant `1.0.0`). Évite le tri
 * lexicographique qui ordonne `1.10.0` avant `1.9.0`.
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, ...pre] = String(value ?? '').split('-');
    const nums = core.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
    return { nums, pre: pre.join('-') || null };
  };
  const va = parse(a);
  const vb = parse(b);
  const hasNaN = va.nums.some(Number.isNaN) || vb.nums.some(Number.isNaN);
  if (hasNaN) return String(a).localeCompare(String(b), undefined, { numeric: true });
  const length = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < length; i += 1) {
    const left = va.nums[i] ?? 0;
    const right = vb.nums[i] ?? 0;
    if (left !== right) return left - right;
  }
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && vb.pre) return 1;
  if (va.pre && vb.pre) return va.pre.localeCompare(vb.pre, undefined, { numeric: true });
  return 0;
}

/** Aplati le regroupement { licence: [package, ...] } renvoyé par pnpm en lignes. */
export function flattenLicenseMap(licenseMap) {
  const rows = [];
  for (const [license, packages] of Object.entries(licenseMap ?? {})) {
    for (const pkg of packages ?? []) {
      const versions = Array.isArray(pkg.versions) && pkg.versions.length ? pkg.versions : [pkg.version ?? 'unknown'];
      for (const version of versions) {
        rows.push({
          name: pkg.name,
          version,
          license,
          tier: classifyLicenseExpression(license),
          author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? ''),
          homepage: pkg.homepage ?? '',
          description: pkg.description ?? '',
        });
      }
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version));
  return rows;
}

function runPnpmListDepthZero() {
  const result = spawnSync('pnpm', ['list', '--depth', '0', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
  });
  if (result.error) {
    console.error('[audit:licenses] `pnpm list` indisponible :', result.error.message);
    process.exit(2);
  }
  const raw = (result.stdout || '').trim();
  if (!raw) {
    console.error('[audit:licenses] `pnpm list --depth 0 --json` n’a rien renvoyé.');
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[audit:licenses] JSON `pnpm list` illisible — échec fermé.');
    process.exit(2);
  }
  const projects = Array.isArray(parsed) ? parsed : [parsed];
  const project = projects.find((entry) => entry && (entry.dependencies || entry.devDependencies)) ?? projects[0] ?? {};
  return {
    dependencies: project.dependencies ?? {},
    devDependencies: project.devDependencies ?? {},
  };
}

export function packageIdentity(name, version) {
  return `${name}@${version}`;
}

/**
 * Décide du scope d'une dépendance à partir de son identité `name@version`,
 * jamais du seul nom : une version déclarée directement ne doit pas faire
 * passer une autre version transitive pour « directe », ni un paquet dev être
 * promu en production par simple homonymie.
 */
export function classifyDependencyScope(identity, { directProdIds, prodIds, directDevIds }) {
  if (directProdIds.has(identity)) return 'direct-prod';
  if (prodIds.has(identity)) return 'transitive-prod';
  if (directDevIds.has(identity)) return 'direct-dev';
  return 'transitive-dev';
}

/**
 * Construit l'inventaire complet (direct + transitif, prod + dev) à partir de
 * `pnpm licenses list` et des versions réellement résolues (`pnpm list
 * --depth 0`). Chaque ligne porte un `scope` :
 *   direct-prod | direct-dev | transitive-prod | transitive-dev
 */
export function buildDependencyLicenseInventory() {
  const listed = runPnpmListDepthZero();
  const directProdIds = new Set();
  const directDevIds = new Set();
  for (const [name, info] of Object.entries(listed.dependencies)) {
    if (info?.version) directProdIds.add(packageIdentity(name, info.version));
  }
  for (const [name, info] of Object.entries(listed.devDependencies)) {
    if (info?.version) directDevIds.add(packageIdentity(name, info.version));
  }

  const full = flattenLicenseMap(runPnpmLicenses());
  const prodIds = new Set(
    flattenLicenseMap(runPnpmLicenses(['--prod'])).map((row) => packageIdentity(row.name, row.version)),
  );

  for (const row of full) {
    row.scope = classifyDependencyScope(packageIdentity(row.name, row.version), {
      directProdIds,
      prodIds,
      directDevIds,
    });
  }
  return full;
}

export function renderThirdPartyNotices(rows, { generatedAt } = {}) {
  const distributed = rows.filter((row) => row.scope === 'direct-prod' || row.scope === 'transitive-prod');
  const byLicense = new Map();
  for (const row of distributed) {
    if (!byLicense.has(row.license)) byLicense.set(row.license, []);
    byLicense.get(row.license).push(row);
  }
  const licenses = [...byLicense.keys()].sort();

  const lines = [];
  lines.push('# Third-Party Notices');
  lines.push('');
  lines.push(
    'Ce fichier liste les dépendances tierces effectivement distribuées avec Clubika ' +
      '(dépendances de production directes et transitives, image de build incluse) ' +
      'ainsi que la licence déclarée par leur registre npm.',
  );
  lines.push('');
  lines.push(
    '**Génération automatisée — pas un avis juridique.** Généré par ' +
      '`pnpm run audit:licenses` (`scripts/audit-dependencies.mjs`) à partir de ' +
      '`pnpm licenses list --json`. Toute entrée marquée `review` doit être lue par un ' +
      'humain avant publication commerciale ; voir `docs/compliance/README.md` et ' +
      '`docs/compliance/dependency-license-inventory.json` pour le détail (dépendances ' +
      'de développement incluses, non distribuées).',
  );
  lines.push('');
  // Date volontairement optionnelle : l'artefact généré est comparé au dépôt
  // par `git diff --exit-code` en CI. Une date « maintenant » serait volatile
  // et ferait échouer le gate à chaque exécution ; elle n'est donc écrite que
  // lorsqu'un horodatage reproductible est fourni (SOURCE_DATE_EPOCH).
  if (generatedAt) {
    lines.push(`Généré le : ${generatedAt.toISOString().slice(0, 10)}`);
    lines.push('');
  }
  for (const license of licenses) {
    lines.push(`## ${license}`);
    lines.push('');
    const pkgs = byLicense.get(license).sort((a, b) => a.name.localeCompare(b.name) || compareVersions(a.version, b.version));
    for (const pkg of pkgs) {
      const tierNote = pkg.tier === 'allowed' ? '' : ` — ⚠️ ${pkg.tier}, revue humaine requise`;
      const homepage = pkg.homepage ? ` — ${pkg.homepage}` : '';
      lines.push(`- \`${pkg.name}@${pkg.version}\`${homepage}${tierNote}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Horodatage reproductible optionnel. Sans `SOURCE_DATE_EPOCH`, les artefacts
 * ne portent aucune date : c'est ce qui garantit que régénérer l'inventaire sur
 * un commit inchangé produit un fichier identique (gate `git diff --exit-code`).
 */
function reproducibleGeneratedAt() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000);
  return undefined;
}

function writeLicenseArtifacts() {
  const rows = buildDependencyLicenseInventory();
  const generatedAt = reproducibleGeneratedAt();
  mkdirSync(COMPLIANCE_DIR, { recursive: true });
  const inventory = {
    note: "Inventaire automatisé (issue #39). Outil d'aide, pas un avis juridique. Toute ligne reste soumise à revue humaine avant commercialisation.",
    generatedBy: 'scripts/audit-dependencies.mjs --licenses (pnpm licenses list --json)',
    packageCount: rows.length,
    tierCounts: {
      allowed: rows.filter((r) => r.tier === 'allowed').length,
      review: rows.filter((r) => r.tier === 'review').length,
      blocked: rows.filter((r) => r.tier === 'blocked').length,
    },
    dependencies: rows,
  };
  if (generatedAt) {
    inventory.generatedAt = generatedAt.toISOString();
  }
  writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2) + '\n');
  writeFileSync(NOTICES_PATH, renderThirdPartyNotices(rows, generatedAt ? { generatedAt } : {}) + '\n');
  return rows;
}

function runLicenseAudit() {
  const rows = writeLicenseArtifacts();
  const blocked = rows.filter((row) => row.tier === 'blocked');
  const review = rows.filter((row) => row.tier === 'review');
  console.log(
    `Licences : ${rows.length} paquet(s) — allowed=${rows.length - blocked.length - review.length} review=${review.length} blocked=${blocked.length}`,
  );
  console.log(`Écrit : ${INVENTORY_PATH.replace(ROOT + '/', '')} et ${NOTICES_PATH.replace(ROOT + '/', '')}`);
  if (review.length) {
    console.log('[audit:licenses] À revoir (non bloquant, revue humaine requise) :');
    for (const row of review) console.log(`  - ${row.name}@${row.version} (${row.license}, ${row.scope})`);
  }
  if (blocked.length) {
    console.error('[audit:licenses] Licences interdites ou absentes détectées :');
    for (const row of blocked) console.error(`  - ${row.name}@${row.version} (${row.license || 'aucune licence déclarée'}, ${row.scope})`);
    process.exit(1);
  }
  console.log('Aucune licence interdite détectée.');
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
  if (process.argv.includes('--licenses')) {
    runLicenseAudit();
  } else {
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
}
