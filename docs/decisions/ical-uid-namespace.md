# Namespacing des UID iCal par club et type d'événement (issue #278)

## Constat

`event.id` n'est unique que localement, par couple (club, type d'événement) : deux clubs
distincts — ou deux types d'événement différents au sein d'un même club (un match officiel et
un entraînement, par exemple) — peuvent partager le même `id`. Avant cette issue, l'UID émis
dans le flux iCal (`app/lib/utils/ical-export.ts`) était `${event.id}@clubika`, sans aucun
namespace : deux événements distincts partageant le même `id` local produisaient donc le même
UID. Or RFC 5545 (§3.8.4.7) attend un UID globalement unique et stable dans le temps pour
chaque `VEVENT` — un client calendrier peut fusionner ou écraser deux événements qui partagent
le même UID.

## Décision

L'UID devient `<type>-<id>@<clubId>.clubika`, où :

- `<type>` est le type d'événement (`officiel`, `amical`, `entrainement`, `plateau`) ;
- `<id>` est l'`id` local existant de l'événement (inchangé) ;
- `<clubId>` est l'identifiant du club émetteur du flux.

Les trois segments sont assainis (`sanitizeUidSegment`) pour ne garder que des caractères
ASCII sûrs (`[A-Za-z0-9._-]`), conformément à RFC 5545.

L'UID n'est **volontairement** dérivé que de ces trois identifiants stables — jamais d'un champ
éditable (titre, lieu, horaire…) — pour que modifier un événement ne change pas son UID : un
nouvel UID à chaque édition ferait perdre aux clients calendrier l'historique et les rappels
déjà associés à l'événement.

Deux points d'émission produisent un flux `.ics` et sont concernés :

- `app/api/ical/[token]/route.ts` (flux d'abonnement par jeton) — passe désormais `clubId:
  user.clubId` dans les options de `generateIcal`.
- `app/components/ui/export-ical-modal.tsx` (export ponctuel téléchargé depuis l'app) — passe
  désormais `clubId: user?.clubId` (utilisateur courant, via `useCurrentUser`).

## Compatibilité avec les abonnements existants — changement cassant assumé

Ce changement est **cassant** pour les abonnements déjà en place : un client qui avait déjà
synchronisé le flux avec l'ancien format `${event.id}@clubika` verra, après ce déploiement,
chaque événement apparaître en doublon jusqu'à la prochaine resynchronisation complète de son
calendrier (l'ancien UID reste dans son cache local ; le nouvel UID namespacé est traité comme
un événement inédit, pas comme une mise à jour de l'ancien).

Options envisagées et pourquoi elles n'ont pas été retenues :

- **Garder l'ancien format en fallback / migration progressive** : impossible sans état
  serveur — le flux est stateless (recalculé à chaque requête), il n'existe pas de registre
  de « qui a déjà vu quel UID » à consulter pour décider quel format servir à quel client.
- **Continuer à émettre l'ancien format sans le namespace** : annulerait le correctif — c'est
  exactement le format à l'origine de la collision qu'on corrige.
- **Faire porter l'UID par un identifiant totalement nouveau (UUID) stocké en base** :
  solution plus lourde (migration de données, colonne supplémentaire) pour un gain marginal
  par rapport au namespace déterministe choisi, qui reste calculable sans état persistant
  supplémentaire et respecte déjà la contrainte de stabilité.

Le remède pour un abonné gêné par le doublon transitoire est de se désabonner puis se
réabonner au flux (ou de forcer une resynchronisation complète si son application calendrier
le permet). Ce compromis est documenté dans le code juste au-dessus de `buildEventUid` dans
`app/lib/utils/ical-export.ts`.
