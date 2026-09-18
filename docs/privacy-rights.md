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

## Suppression d’un message de chat ≠ demande RGPD d’effacement du compte

Ces deux actions sont volontairement distinctes et ne doivent pas être confondues :

- **Suppression d’un message** (`deleteMessage`, [`app/lib/chat/service.ts`](../app/lib/chat/service.ts) ; issues [#259](https://github.com/brahmiamine/Clubika/issues/259) et [#10](https://github.com/brahmiamine/Clubika/issues/10)) : action immédiate, en libre-service, déclenchée par l’auteur du message lui-même ou par un administrateur du club depuis l’interface de chat (`chat:delete`). Elle purge le contenu chiffré, la pièce jointe et les réactions d’**un seul message**, et ne conserve qu’un tombstone minimal (`deletedAt`, `deletedByUserId`) nécessaire à l’ordre, la pagination et les compteurs de non-lus. Elle ne touche ni le compte de l’auteur, ni ses autres messages, ni son identité (`senderName` reste affiché).
- **Demande RGPD d’effacement du compte** (`anonymizeMessagesForDeletedUser`, même fichier ; issue [#11](https://github.com/brahmiamine/Clubika/issues/11), à la charge d’une décision humaine + de la procédure décrite ci-dessus) : porte sur **l’ensemble du compte**, pas un message isolé. Elle anonymise l’attribution (`senderName` → « Utilisateur supprimé ») de tous les messages envoyés ou transférés par la personne, sans purger leur contenu — le contenu des échanges reste visible aux autres participants, seule l’identité de l’auteur est retirée.

En résumé : supprimer un message retire son contenu mais garde l’identité de l’auteur ; l’effacement RGPD du compte garde le contenu des messages mais retire l’identité de l’auteur. Ce ne sont pas des équivalents fonctionnels, et l’un ne dispense pas de l’autre.

## Migration 0038 `exercice_droits_rgpd`

Tables `privacy_requests`, `privacy_export_tokens`, `privacy_contact_changes` et colonnes `processingRestrictedAt` / `processingOpposedAt`. Idempotente (`IF NOT EXISTS`). Pas de purge destructive.

## Configuration

Aucun secret supplémentaire. L’envoi du lien de confirmation d’e-mail hors production expose `confirmToken` dans la réponse JSON (comme le reset mot de passe). En production, brancher un canal d’e-mail existant avant de compter sur ce lien.

## Risque résiduel

- L’effacement réel des comptes référencés n’est pas exécuté ici : décision humaine + #11.
- Un administrateur peut lier une demande publique en saisissant l’e-mail déclaré : c’est volontairement proportionné, pas une pièce d’identité.
- Revue humaine sécurité/RGPD avant fusion.
