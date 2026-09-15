# Rapports post-événement — accès (issue #28)

Les rapports (`post-event-report`) ont une matrice d’autorisation **distincte** de l’espace événement / chat. Être affecté à l’événement ne donne plus accès aux rapports des autres.

Catégories conservées comme statuts structurés non nominatifs : `organisation`, `incident`, `sportif`, `other`. Le texte libre reste visible seulement pour l’auteur et l’admin du tenant.

## Matrice

| Action | Auteur | Admin du même tenant | Affecté non-auteur | Admin d’un autre tenant |
| --- | --- | --- | --- | --- |
| Créer | Oui, après le début de l’événement s’il est affecté | Oui | Oui s’il est affecté et que l’événement a commencé | Non |
| Lire (liste / détail) | Ses rapports seulement | Tous les rapports du tenant | Non | Non (404 identique) |
| Modifier | Ses rapports seulement | Non | Non | Non |
| Supprimer | Ses rapports | Tous les rapports du tenant | Non | Non |
| Exporter / audit / logs / outbox | Jamais le corps du rapport | Jamais le corps | Jamais | Jamais |

Les erreurs d’accès, d’événement inconnu, de rapport supprimé ou hors tenant répondent `{ "error": "Not found" }` en 404, sans auteur ni catégorie.

Les notifications se limitent à « Un rapport est disponible ».

La suppression efface la ligne `planning_records` : l’historique d’audit ne conserve que `{ reportId }`.
