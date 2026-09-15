# Exports de planning (issue #33)

Les exports administrateur (CSV, PDF, JSON, HTML) passent par une projection
serveur allowlistée. L’API ne renvoie plus les objets métier bruts.

## Colonnes

Défaut (opérationnel) : date, heure, type, catégorie, compétition, équipes, lieu.

Identités / téléphones / statut individuel : désactivés. Ils exigent :

1. une case à cocher explicite,
2. une finalité d’au moins 8 caractères,
3. aucune action « tout sélectionner » sur les champs sensibles.

Interdit : `rawText`, secrets, tokens, corps de rapport/chat/commentaire, motifs
de refus, audits, erreurs fournisseur, données de santé.

## Lien de téléchargement

`POST /api/planning/export` crée un jeton opaque (2 minutes, usage unique),
stocké hashé. `GET /api/planning/export/[token]` (session admin, même club)
régénère le fichier. `Cache-Control: private, no-store`. Nom de fichier
`planning-export.{csv|json|html|pdf}` — pas de nom de personne.

## Kill switch

Flag `features.massExport` (défaut : activé). Désactivation → 409.

## Audit

Enregistrement `export-audit` : acteur pseudonymisé, date, format, colonnes,
finalité, volume. Jamais le contenu exporté.

## CSV

Neutralisation `= + - @`, tabulation, retours et variantes Unicode en tête de
cellule (apostrophe préfixe), côté serveur et client.
