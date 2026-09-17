# Licences, provenance des actifs et marques (issue #39)

`needs:legal-review`, priorité p0. **Aucun agent IA ne peut valider une
licence ou une autorisation de marque à lui seul.** Ce dossier fournit
l'outillage, l'inventaire et le gate CI demandés par le ticket ; il ne
constitue jamais, par lui-même, une décision de conformité. Une revue
humaine propriété intellectuelle / marques reste obligatoire avant toute
commercialisation.

## Ce que ce dossier contient

| Fichier | Contenu | Généré par |
| --- | --- | --- |
| `dependency-license-inventory.json` | Dépendances npm directes + transitives (prod et dev), licence déclarée, tier (`allowed`/`review`/`blocked`) | `pnpm run audit:licenses` |
| `../../THIRD_PARTY_NOTICES.md` | Sous-ensemble distribué (prod direct + transitif) du fichier ci-dessus, au format notice | `pnpm run audit:licenses` |
| `asset-registry.json` | Registre des actifs binaires (images, SVG, audio, icônes) sous `public/` et ailleurs : auteur/source, date, licence/autorisation, modifications, preuve, statut | Maintenu à la main, vérifié par `pnpm run audit:assets` |
| `../../LICENSE` | Notice « All Rights Reserved » — placeholder réversible, pas un choix final | Ajouté manuellement |

## Comment les outils fonctionnent

- `node scripts/audit-dependencies.mjs --licenses` (alias `pnpm run
  audit:licenses`) appelle `pnpm licenses list --json` (avec et sans
  `--prod`), classe chaque paquet en `allowed` / `review` / `blocked` par
  heuristique SPDX (voir commentaire en tête de
  `scripts/audit-dependencies.mjs`), puis régénère
  `dependency-license-inventory.json` et `THIRD_PARTY_NOTICES.md`. La CI
  échoue si un paquet est `blocked` (licence absente, `UNLICENSED`, ou
  copyleft fort/non-commercial connu), et échoue aussi si les fichiers
  générés divergent de ce qui est committé (`git diff --exit-code`), pour
  éviter un inventaire périmé.
- `node scripts/check-asset-registry.mjs` (alias `pnpm run audit:assets`)
  parcourt le dépôt à la recherche de fichiers d'actifs (images, SVG, audio,
  police, icône, vidéo) et échoue si l'un d'eux n'a pas d'entrée dans
  `asset-registry.json`, si une entrée pointe vers un fichier supprimé, ou si
  un champ obligatoire est vide. Il ne vérifie **que** la présence et le
  remplissage des champs — jamais l'exactitude juridique de leur contenu.

Ces deux scripts sont exécutés dans le job `license-and-asset-provenance` du
workflow `.github/workflows/supply-chain.yml`.

## Ce qui reste une décision humaine (liste ouverte)

### Choix de licence du code propriétaire

`LICENSE` pose un placeholder « All Rights Reserved » réversible. Le choix
final (rester propriétaire, publier sous licence OSI, licence duale, etc.)
et ses implications (cession de droits des contributeurs, visibilité du
dépôt) doivent être tranchés par un humain habilité, pas par cet outillage.

### Dépendances marquées `review` dans l'inventaire de licences

Non bloquantes pour la CI (ce ne sont pas des licences interdites connues),
mais nécessitent une lecture humaine avant publication commerciale :

- `mariadb@3.5.3` — LGPL-2.1-or-later, dépendance directe de production
  (pilote MariaDB officiel, utilisé sans modification).
- `@img/sharp-libvips-linux-x64@1.3.3` — LGPL-3.0-or-later, binaire natif
  transitif de `sharp` (traitement d'image), production.
- `web-push@3.6.7` — MPL-2.0, dépendance directe de production.
- `axe-core@4.11.1`, `lightningcss@1.30.2`/`1.33.0`,
  `lightningcss-linux-x64-gnu@1.30.2`/`1.33.0` — MPL-2.0, outillage de build/
  test (dev uniquement, non distribué).

Toute nouvelle entrée `review` ou `blocked` apparaît automatiquement dans
`dependency-license-inventory.json` (`tierCounts`) au prochain
`pnpm run audit:licenses`.

### Actifs à provenance non établie (`status: needs_human_review`)

Les 11 fichiers actuellement sous `public/` sont **tous** dans cet état —
voir `asset-registry.json` pour le détail par fichier (preuve technique,
date d'ajout au dépôt, hash). Résumé :

- `public/branding/clubika-icon.png`, `public/branding/clubika-logo.png`,
  `public/branding/clubika-logo-dark.png`, `public/pwa/icon-192.png`,
  `public/pwa/icon-512.png` : métadonnées **C2PA/XMP vérifiées** (`strings
  <fichier> | grep -i openai`) attribuant la génération à « OpenAI Media
  Service API » (OpenAI OpCo, LLC). **Cela n'établit à lui seul aucun droit
  de commercialisation** de la marque Clubika ni du logo — c'est un fait
  technique sur l'outil de génération, pas une autorisation. `pwa/icon-512.png`
  est de plus un doublon octet pour octet de `pwa/icon-192.png` (même sha256).
- `public/branding/icon.png`, `public/branding/icon-512.png`,
  `public/favicon.png`, `public/favicon.ico` : aucune métadonnée détectée.
  **L'absence de métadonnée n'est jamais traitée comme preuve de liberté
  d'usage** (rappel explicite du critère d'acceptation de l'issue).
- `public/sounds/chat-received.wav`, `public/sounds/chat-sent.wav` : fichiers
  RIFF/WAVE bruts sans chunk de métadonnée exploitable. Provenance inconnue.
- `public/branding/clubika-logo.png` et `clubika-logo-dark.png` sont de plus
  **actuellement inutilisés** par le code applicatif (recherche exhaustive,
  0 référence) — conservés car il ne s'agit pas de boilerplate Next.js/
  Vercel (hors du critère de suppression automatique de cette issue), mais
  signalés pour arbitrage humain : supprimer, ou documenter un usage prévu.

Aucun de ces fichiers n'a été retiré : retirer un actif de marque activement
utilisé casserait le produit sans autorité légale pour trancher. La décision
« retirer / remplacer / obtenir une autorisation documentée » revient à la
revue humaine demandée par le ticket.

### Actifs de club/adverses (hors registre de fichiers)

Les logos de club et de club adverse ne sont pas des fichiers du dépôt : ils
sont saisis comme URL par un compte club (`app/components/plateforme/
OpponentClubsSection.tsx` et la configuration du club propriétaire). Le code
actuel ne scrape ni ne proxifie ces logos (échec silencieux via `onError` si
l'URL est invalide) — cohérent avec le critère « pas de scraping/import de
logo par défaut ». En revanche, **aucune vérification technique n'existe**
pour s'assurer que l'URL saisie provient bien d'un représentant autorisé,
avec finalité et durée déclarées, ni de procédure de retrait/replacement
documentée. C'est une politique de gouvernance à formaliser humainement
(processus, CGU club, contrat), pas un changement de code que cet outillage
peut ou doit trancher — voir `docs/compliance/asset-registry.json` →
`non_static_provenance_items`.

## Boilerplate Next.js/Vercel supprimé

`public/next.svg`, `public/vercel.svg`, `public/file.svg`,
`public/globe.svg`, `public/window.svg` : icônes par défaut de
`create-next-app`, sans aucune référence dans le dépôt (recherche
exhaustive avant suppression). Retirés par cette issue. Voir
`asset-registry.json` → `removed_assets` pour la trace de la vérification.

## Hors périmètre de cette issue

- Audit spécifique des actifs SportCorico : couvert par les issues #4 et #5
  (fermées), non repris ici.
- Vulnérabilités de sécurité des dépendances (`pnpm audit`) : issue #37,
  `scripts/audit-dependencies.mjs` (mode par défaut, inchangé) et
  `security/README.md`.
- Modification du flux d'upload/saisie de logo de club (code applicatif) :
  non demandée par le ticket, qui porte sur l'outillage/l'inventaire, pas
  sur une nouvelle fonctionnalité produit.
