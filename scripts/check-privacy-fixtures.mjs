#!/usr/bin/env node
/**
 * Refuse les données à caractère personnel réalistes AJOUTÉES aux fixtures, aux
 * snapshots et aux tests (issue #41).
 *
 * Ce script duplique volontairement, sans import croisé, les heuristiques de
 * `app/lib/privacy-invariants/pii-heuristics.ts` : c'est un script Node exécuté
 * tel quel en CI (`pnpm run privacy:fixtures`), avant toute étape de compilation
 * TypeScript, donc il ne peut pas importer ce module ESM/TS directement sans
 * ajouter une dépendance de build à la CI. `pii-heuristics.test.ts` fait tourner
 * les mêmes cas sur le module TypeScript pour empêcher toute dérive silencieuse
 * entre les deux — si tu changes une règle ici, répercute-la aussi là-bas (et
 * inversement).
 *
 * Mode par défaut : DIFF INCRÉMENTAL contre la branche de base, pas un scan de
 * tout le dépôt. Le dépôt contient déjà, avant cette issue, des centaines de
 * numéros/e-mails de test « plausibles mais fictifs » dans sa suite de tests
 * existante (`0612345678`, `admin@club.example`…) ; les scanner tous en continu
 * bloquerait toute PR sans rapport avec eux. Le libellé de l'issue #41 est
 * d'ailleurs explicite : détecter ce qui est « ajouté » aux fixtures/snapshots.
 * `--full` scanne tout le dépôt (utile pour un audit ponctuel, pas pour la CI).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Domaines conventionnels du dépôt : jamais un vrai contact (RFC 2606, RFC 5737).
export const SAFE_EMAIL_DOMAIN_SUFFIXES = ['.test', '.invalid', '.example', '.localhost'];
export const SAFE_EMAIL_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'example.test', 'example.invalid',
  'invalid.local', 'clubika.invalid',
];

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\b0[1-9](?:[\s.-]?\d{2}){4}\b/g;
const SAFE_PHONE_PREFIXES = ['0600000000', '0700000000', '0000000000', '0699000000'];

const SECRET_PATTERNS = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-live-key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
];

/** Uniquement les chemins qui ressemblent à des fixtures/snapshots/tests. */
export const FIXTURE_PATH_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__snapshots__\//,
  /\.snap$/,
  /\/fixtures\//,
  /\.fixture\.[jt]s$/,
];

const IGNORED_PATHS = new Set([
  // Contient forcément les motifs de détection eux-mêmes.
  'scripts/check-privacy-fixtures.mjs',
  // Teste volontairement le chemin de détection *positif* de pii-heuristics.ts
  // avec des exemples plausibles (jean.dupont@gmail.com, 06 12 34 56 78, clés de
  // fournisseur factices…) : ce ne sont pas de vraies données ajoutées à une
  // fixture, c'est la preuve que le détecteur les reconnaît. Même exception côté
  // TypeScript, voir pii-heuristics.test.ts.
  'app/lib/privacy-invariants/pii-heuristics.test.ts',
]);

function isSafeEmail(email) {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (SAFE_EMAIL_DOMAINS.includes(domain)) return true;
  return SAFE_EMAIL_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

function isSafePhone(rawMatch) {
  const digits = rawMatch.replace(/\D/g, '');
  if (SAFE_PHONE_PREFIXES.includes(digits)) return true;
  // Bloc entier réservé par sentinelPhone() (sentinel-factory.ts), pas seulement
  // le préfixe exact 0699000000 : voir la même exception dans pii-heuristics.ts.
  if (/^0699000\d{3}$/.test(digits)) return true;
  if (/^(\d)\1{9}$/.test(digits)) return true;
  if (digits === '0102030405' || digits === '0123456789') return true;
  return false;
}

export function findRealisticPii(text) {
  const findings = [];
  for (const match of text.matchAll(EMAIL_RE)) {
    const value = match[0];
    if (!isSafeEmail(value)) findings.push({ kind: 'email', id: 'realistic-email-domain', value });
  }
  for (const match of text.matchAll(PHONE_RE)) {
    const value = match[0];
    if (!isSafePhone(value)) findings.push({ kind: 'phone', id: 'realistic-phone-number', value });
  }
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.re.exec(text);
    if (match) findings.push({ kind: 'secret', id: pattern.id, value: match[0] });
  }
  return findings;
}

export function isFixturePath(relativePath) {
  if (IGNORED_PATHS.has(relativePath)) return false;
  return FIXTURE_PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}

/** Ne montre jamais la valeur trouvée en clair dans le rapport (issue #41 : rapport sans valeurs personnelles). */
function redact(value) {
  if (value.length <= 4) return '***';
  return `${value.slice(0, 2)}***${value.slice(-1)}`;
}

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** Premier ref qui existe réellement dans ce clone, dans l'ordre de préférence. */
export function resolveBaseRef(root = ROOT, env = process.env) {
  const candidates = [
    env.PRIVACY_FIXTURES_BASE_REF,
    env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : null,
    'origin/dev',
    'origin/main',
    'HEAD~1',
  ].filter(Boolean);
  for (const ref of candidates) {
    try {
      git(['rev-parse', '--verify', '--quiet', ref], root);
      return ref;
    } catch {
      // essaie le candidat suivant
    }
  }
  return null;
}

/**
 * Parse un `git diff --unified=0` et retourne chaque ligne AJOUTÉE dans un
 * fichier fixture/snapshot/test, avec son numéro de ligne dans le fichier final.
 */
export function parseAddedFixtureLines(diffText) {
  const lines = diffText.split('\n');
  const results = [];
  let currentPath = null;
  let include = false;
  let newLine = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      currentPath = null;
      include = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const match = line.match(/^\+\+\+ b\/(.*)$/);
      currentPath = match ? match[1] : null;
      include = currentPath ? isFixturePath(currentPath) : false;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!include) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      results.push({ path: currentPath, line: newLine, content: line.slice(1) });
      newLine += 1;
    }
    // Les lignes '-' (supprimées) et les lignes de contexte n'existent pas en
    // --unified=0 ; on ignore tout le reste (métadonnées de hunk, "\ No newline…").
  }
  return results;
}

export function scanDiff(root, baseRef) {
  const diffText = git(['diff', '--unified=0', '--no-color', `${baseRef}...HEAD`], root);
  const addedLines = parseAddedFixtureLines(diffText);
  const violations = [];
  for (const added of addedLines) {
    for (const finding of findRealisticPii(added.content)) {
      violations.push({
        path: added.path,
        line: added.line,
        kind: finding.kind,
        id: finding.id,
        redacted: redact(finding.value),
      });
    }
  }
  return { scannedLines: addedLines.length, violations };
}

export function scanFullRepo(root = ROOT) {
  const files = git(['ls-files'], root).split('\n').filter(Boolean).filter(isFixturePath);
  const violations = [];
  for (const relativePath of files) {
    let text;
    try {
      text = readFileSync(join(root, relativePath), 'utf8');
    } catch {
      continue;
    }
    for (const finding of findRealisticPii(text)) {
      const line = text.slice(0, text.indexOf(finding.value)).split('\n').length;
      violations.push({ path: relativePath, line, kind: finding.kind, id: finding.id, redacted: redact(finding.value) });
    }
  }
  return { scannedFiles: files.length, violations };
}

function reportAndExit(violations, scannedDescription) {
  if (violations.length > 0) {
    console.error(`[privacy:fixtures] ${violations.length} donnée(s) à caractère personnel plausible(s) détectée(s) (${scannedDescription}) :`);
    for (const violation of violations) {
      console.error(`  ::error file=${violation.path},line=${violation.line}::${violation.kind} (${violation.id}) — valeur rédigée : ${violation.redacted}`);
    }
    console.error('\nRemplace cette valeur par une donnée sentinelle (voir app/lib/privacy-invariants/sentinel-factory.ts) : domaine .test/.invalid/.example, numéro 0600000000/0699000000, jamais un vrai nom/domaine/secret.');
    process.exit(1);
  }
  console.log(`[privacy:fixtures] OK — ${scannedDescription}, aucune donnée personnelle plausible détectée.`);
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked || process.argv[1]?.endsWith('check-privacy-fixtures.mjs')) {
  if (process.argv.includes('--full')) {
    const { scannedFiles, violations } = scanFullRepo();
    reportAndExit(violations, `${scannedFiles} fichier(s) de fixtures/snapshots/tests, dépôt entier`);
  } else {
    const baseRef = resolveBaseRef();
    if (!baseRef) {
      console.error('[privacy:fixtures] Impossible de déterminer une branche de base pour le diff incrémental (clone superficiel ?). '
        + 'Assure un `fetch-depth: 0` et un `git fetch origin dev` avant cette étape, ou lance `--full` pour un audit ponctuel du dépôt entier.');
      process.exit(1);
    }
    const { scannedLines, violations } = scanDiff(ROOT, baseRef);
    reportAndExit(violations, `${scannedLines} ligne(s) ajoutée(s) dans des fixtures/snapshots/tests, diff contre ${baseRef}`);
  }
}
