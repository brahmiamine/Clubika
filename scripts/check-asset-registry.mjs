#!/usr/bin/env node
/**
 * Vérifie que chaque actif binaire du dépôt (image, SVG, audio, police, icône)
 * a une entrée dans docs/compliance/asset-registry.json (issue #39,
 * needs:legal-review). N'établit AUCUNE provenance ni autorisation : vérifie
 * seulement qu'une entrée existe et que ses champs obligatoires sont
 * renseignés. Le contenu de ces champs reste sujet à revue humaine.
 *
 * Échec fermé : un fichier d'actif sans entrée de registre, ou une entrée de
 * registre pointant vers un fichier qui n'existe plus, bloque la CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(ROOT, 'docs/compliance/asset-registry.json');

// Extensions considérées comme « actif » au sens de l'issue #39 : image,
// SVG, audio, police, icône. Le code source (.ts/.tsx/.mjs/.json/...) n'est
// pas concerné.
export const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif', '.bmp',
  '.wav', '.mp3', '.ogg', '.m4a', '.flac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.mp4', '.webm', '.mov',
]);

// Dossiers jamais scannés : dépendances, build, outils versionnés à part.
const IGNORED_DIR_NAMES = new Set([
  'node_modules', '.git', '.next', 'out', 'dist', 'coverage',
  '.pnpm-store', 'test-results', 'playwright-report',
]);

export function findAssetFiles(root = ROOT, dir = root, results = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      findAssetFiles(root, full, results);
      continue;
    }
    const lower = entry.toLowerCase();
    const dotIndex = lower.lastIndexOf('.');
    if (dotIndex === -1) continue;
    const ext = lower.slice(dotIndex);
    if (ASSET_EXTENSIONS.has(ext)) {
      results.push(relative(root, full).split('\\').join('/'));
    }
  }
  return results.sort();
}

const REQUIRED_FIELDS = ['path', 'type', 'author_source', 'date', 'license_authorization', 'modifications', 'proof', 'status'];

export function loadRegistry(path = REGISTRY_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.assets)) {
    throw new Error('docs/compliance/asset-registry.json : "assets" doit être un tableau.');
  }
  return parsed;
}

/**
 * Compare les fichiers d'actifs présents sur disque au registre.
 * Retourne { missing, stale, incomplete } — tous doivent être vides pour
 * que la vérification passe.
 */
export function diffAssetsAgainstRegistry(assetFiles, registry) {
  const byPath = new Map(registry.assets.map((entry) => [entry.path, entry]));
  const removedPaths = new Set((registry.removed_assets ?? []).map((entry) => entry.path));

  const missing = assetFiles.filter((file) => !byPath.has(file));
  const stale = [...byPath.keys()].filter((path) => !assetFiles.includes(path) && !removedPaths.has(path));

  const incomplete = [];
  for (const entry of registry.assets) {
    const emptyFields = REQUIRED_FIELDS.filter((field) => {
      const value = entry[field];
      return typeof value !== 'string' || value.trim().length === 0;
    });
    if (emptyFields.length) {
      incomplete.push({ path: entry.path, emptyFields });
    }
  }

  return { missing, stale, incomplete };
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked || process.argv[1]?.endsWith('check-asset-registry.mjs')) {
  const registry = loadRegistry();
  const assetFiles = findAssetFiles();
  const { missing, stale, incomplete } = diffAssetsAgainstRegistry(assetFiles, registry);

  let failed = false;

  if (missing.length) {
    failed = true;
    console.error('[audit:assets] Fichier(s) d’actif sans entrée de registre (docs/compliance/asset-registry.json) :');
    for (const path of missing) console.error(`  - ${path}`);
  }

  if (stale.length) {
    failed = true;
    console.error('[audit:assets] Entrée(s) de registre pointant vers un fichier absent du dépôt :');
    for (const path of stale) console.error(`  - ${path}`);
    console.error('  → déplacer l’entrée vers "removed_assets" avec une raison, ou corriger le chemin.');
  }

  if (incomplete.length) {
    failed = true;
    console.error('[audit:assets] Entrée(s) de registre avec un champ obligatoire vide :');
    for (const item of incomplete) console.error(`  - ${item.path} : ${item.emptyFields.join(', ')}`);
  }

  if (failed) {
    console.error(
      '[audit:assets] Tout actif ajouté au dépôt doit avoir une entrée dans ' +
        'docs/compliance/asset-registry.json (auteur/source, date, licence/autorisation, ' +
        'modifications, preuve, statut). "provenance unknown — needs human review" est ' +
        'une valeur acceptée si la provenance n’est pas établie ; une absence d’entrée ne l’est pas.',
    );
    process.exit(1);
  }

  console.log(`Registre d’actifs à jour : ${assetFiles.length} fichier(s), ${registry.assets.length} entrée(s).`);
}
