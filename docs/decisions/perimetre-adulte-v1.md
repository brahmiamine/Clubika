# Périmètre adulte de la V1 (issue #18)

## Contexte

Clubika V1 ne propose aucun parcours dédié aux mineurs (pas de représentant légal,
pas de consentement parental, pas de règles de conservation adaptées à l'âge). Faute
d'un tel parcours, la V1 réserve ses comptes au **staff majeur** (`admin`, `dirigeant`
— arbitre club, encadrant, accompagnateur). Il n'existe à ce stade **aucun rôle ni
compte « joueur »** dans le modèle de données (`app/lib/auth/roles.ts` ne définit que
`ClubAccessRole = 'admin' | 'dirigeant'`) : le risque visé par le ticket (comptes
joueurs mineurs créés par import ou automatisation) n'a donc pas de chemin
d'exécution dans le code actuel — les imports (`/api/non-account-contacts/import`,
synchronisation SportCorico) ne créent que des profils **sans accès**
(`claimedAt IS NULL`, aucun mot de passe utilisable), jamais des comptes actifs.

## Décision retenue

- **Confirmation, pas collecte d'âge.** L'administrateur qui invite confirme un
  simple booléen (« cette personne est majeure ») ; aucune date de naissance, aucun
  document d'identité n'est demandé ni stocké. Seul l'horodatage de cette
  confirmation (`invitations.adultConfirmedAt`) est conservé.
- **Contrôle appliqué côté serveur.** `POST /api/invitations` refuse (HTTP 400) toute
  création sans `adultConfirmed: true` explicite — un appel direct à l'API qui
  contournerait la case à cocher de l'écran d'invitation est refusé de la même
  façon que l'UI (test dédié : `app/api/invitations/route.test.ts`, describe
  « confirmation de majorité »).
- **Message à l'acceptation.** L'écran d'inscription (`/inscription/[token]`)
  affiche un rappel visible que les comptes V1 sont réservés aux personnes majeures,
  indépendant de la notice club configurable (issue #26).
- **Traitement du compte mineur créé par erreur** (`POST
  /api/users/[id]/minor-erroneous`, admin uniquement) :
  1. **Suspension** immédiate (`active = false`) et révocation de toutes les
     sessions actives ;
  2. **Information** : notification traçable aux administrateurs actifs du club
     (type `minor-account-erroneous-closure`) ;
  3. **Effacement** : anonymisation via le même mécanisme que la fermeture de
     compte standard (`closeAccount`, voir `docs/account-closure.md`), tracé sous
     un motif distinct `processed_by_role = 'minor-erroneous'` dans
     `account_closures` pour l'audit de conformité — pas de nouvelle base légale
     inventée pour ce cas particulier, ni de suppression physique de la ligne
     `users`.

## Points explicitement hors de cette PR — revue juridique et de conception requise

Cette PR **documente** ces questions sans les trancher, conformément au ticket :

1. **CGU publiques.** Aucune page CGU n'existe encore dans le dépôt (issue #12,
   non fusionnée). Le rappel « réservé aux majeurs » ne vit donc aujourd'hui que
   sur l'écran d'invitation et l'écran d'acceptation ; il devra être répété dans
   les CGU dès qu'elles seront rédigées et fusionnées.
2. **Notification de la personne mineure / d'un tuteur légal.** Le traitement
   « compte mineur créé par erreur » ne notifie que les administrateurs du club, pas
   la personne concernée ni un représentant légal — aucun canal de contact vérifié
   n'existe pour cela en V1, et la base légale d'un tel contact reste à définir.
   Ne pas anticiper une pratique découlant d'une décision non prise.
3. **Fenêtre de contestation avant effacement.** Le traitement actuel efface dès
   l'appel de l'administrateur, sans délai de contestation. Un tel délai suppose de
   décider qui peut le déclencher (la personne, un tuteur ?) et par quel canal
   vérifié — question ouverte.
4. **Ouverture à un parcours mineur.** Toute évolution future (comptes joueurs,
   consentement parental, DPO/RGPD enfants) nécessite une revue juridique et de
   conception séparée, non anticipée par ce ticket ni par cette PR.
5. **Avant commercialisation à destination directe des joueurs**, cette restriction
   (et l'ensemble du modèle « staff uniquement ») doit être revue.

**Cette PR ne doit pas être fusionnée avant qu'un humain n'ait statué sur ces
points** (label `needs:legal-review` sur l'issue #18).
