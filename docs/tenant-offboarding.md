# Offboarding d’un club (issue #25)

Procédure technique de fin de contrat d’un tenant : gel, restitution, rétention
produit, suppression/anonymisation, instructions aux sous-traitants, legal hold
et certificat. **Les délais affichés sont des paramètres produit. Ils ne
constituent pas un avis juridique ni une obligation légale calculée par
l’application.** Les bases légales, durées opposables et modèles de réponse
restent une décision humaine (#12 / #40).

Cette livraison part de `dev` et **n’empile pas** les PRs #9 (rétention globale),
#11 (fermeture de compte) ni #24 (sauvegardes chiffrées). Ces sujets restent des
risques résiduels à coordonner à la fusion.

## Parcours plateforme

1. `/plateforme/offboarding/[clubId]` — ou lien « Fin de contrat » depuis la liste des clubs.
2. **Gel** : `active=false`, révocation des sessions, invitations, iCal, push,
   outbox ; instructions sous-traitants ouvertes. Une date de rétention produit
   peut être saisie ; elle n’est **pas** un délai légal.
3. **Restitution** : jeton hashé, TTL 15 minutes, usage unique, `Cache-Control: private, no-store`.
   Archive JSON chiffrée (`APP_ENCRYPTION_KEY`) limitée au tenant, sans
   `passwordHash`, jetons iCal, mot de passe SMTP ni secrets push.
4. **Legal hold** : motif allowlisté (`litige`, `controle_autorite`,
   `instruction_humaine`), périmètre `full_tenant`, expiration future, approbateur
   plateforme. Bloque la purge. Pas de conservation par défaut.
5. **Dry-run** puis **purge** (confirmation de l’identifiant). Idempotente, par
   lots. Le tenant devient un tombstone (`club-supprimé`) : l’id n’est plus
   réutilisable, les identifiants et BLOB sont effacés. Les journaux
   d’offboarding et le certificat (compteurs, hashes) sont conservés sans
   contenu personnel.
6. Accuser réception des sous-traitants (SMTP, Web Push, WhatsApp, scraper)
   sans coller de données personnelles dans les notes.

## Cron

`POST /api/cron/tenant-offboarding` (Bearer `CRON_SECRET`).

Par défaut le cron reste en **dry-run**. La purge réelle exige
`OFFBOARDING_CRON_PURGE=1` **et** une date de rétention produit échue, sans
legal hold. Workflow GitHub : `.github/workflows/tenant-offboarding.yml`
(désactivé tant que `CLUBIKA_SCHEDULE_ENABLED` n’est pas `true`).

## Sauvegardes

Les dumps MariaDB peuvent encore contenir un tenant jusqu’à expiration de la
rotation (`BACKUP_KEEP_DAYS`, ticket #24). Après restauration d’un dump plus
ancien que le certificat :

```bash
pnpm tsx scripts/enforce-tenant-tombstones.ts          # dry-run
ENFORCE_TOMBSTONES=1 pnpm tsx scripts/enforce-tenant-tombstones.ts
```

Archiver le JSON du certificat **hors** de la base (coffre exploitant). Ne pas
remettre en production un dump qui réintroduit un club déjà certifié supprimé.

## Migration 0039

`offboarding_club_tenant` : colonnes d’état sur `club_tenants` + tables
`tenant_offboarding_exports`, `tenant_processor_instructions`,
`tenant_offboarding_events`, `tenant_deletion_certificates`. Idempotente. Pas
de purge destructive au migrate. Ne pas modifier `typeorm-entity-tables.ts`.

Si une autre PR non fusionnée a déjà posé une ligne `schema_migrations` `0039`
sur un bac local, la supprimer avant de tester cette branche.
