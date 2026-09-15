# Exercice des droits (accès, portabilité, rectification, restriction, opposition)

Issue de référence : [#22](https://github.com/brahmiamine/Clubika/issues/22)
(effacement délégué à [#11](https://github.com/brahmiamine/Clubika/issues/11) ;
procédure et modèles de réponse : [#12](https://github.com/brahmiamine/Clubika/issues/12)).

## Ce que le code fait

- Compte authentifié : `/club/profil` et `/mon-planning/profil` (rectification e-mail/téléphone, export, file de demandes).
- Sans compte : `/exercice-des-droits` — club + e-mail + type. L’e-mail n’est stocké que sous empreinte SHA-256.
- File admin : `/club/droits` — états, liaison d’identité, restriction/opposition, export, délégation d’effacement.
- Téléchargement d’export : jeton hashé, TTL 15 min, usage unique, `Cache-Control: private, no-store`.
- Restriction / opposition : drapeau sur `users`, bloque les notifications externes non essentielles. Le compte et les droits restent utilisables.

L’application **n’invente pas** de délai légal, de prolongation ni de refus. Le bandeau `PRIVACY_NO_LEGAL_PROMISE` le rappelle partout.

## Migration 0025 `exercice_droits_rgpd`

Tables `privacy_requests`, `privacy_export_tokens`, `privacy_contact_changes` et colonnes `processingRestrictedAt` / `processingOpposedAt`. Idempotente (`IF NOT EXISTS`). Pas de purge destructive.

## Configuration

Aucun secret supplémentaire. L’envoi du lien de confirmation d’e-mail hors production expose `confirmToken` dans la réponse JSON (comme le reset mot de passe). En production, brancher un canal d’e-mail existant avant de compter sur ce lien.

## Risque résiduel

- L’effacement réel des comptes référencés n’est pas exécuté ici : décision humaine + #11.
- Un administrateur peut lier une demande publique en saisissant l’e-mail déclaré : c’est volontairement proportionné, pas une pièce d’identité.
- Revue humaine sécurité/RGPD avant fusion.
