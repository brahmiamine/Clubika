# Examen de nécessité d’une AIPD (art. 35)

Décision **non signée**. Critères CNIL / G29 rappelés pour l’exploitant.

## Constats produit (faits)

- Pas de champ santé structuré (#7). Commentaires libres possibles : risque
  de données sensibles non classifiées.
- Pas de champ âge : des mineurs peuvent être inscrits sans que le logiciel
  le détecte.
- Auto-affectation selon charge / indisponibilités : aide à l’organisation,
  pas un scoring généralisé ni un profilage commercial.
- Surveillance : journaux d’audit minimisés, pas de vidéosurveillance.
- Échelle : multi-tenant ; le volume dépend du déploiement.

## Décision provisoire (à faire signer)

| Question | Réponse actuelle |
| --- | --- |
| AIPD obligatoire aujourd’hui ? | Non tranché. |
| Si mineurs inscrits ? | Réévaluer avant collecte. |
| Si données sensibles réapparaissent ? | Réévaluer ; le code interdit la santé structurée. |
| Si profilage ou scoring externe ? | Absent du code ; réévaluer s’il est ajouté. |

Tant que cette grille n’est pas signée par un responsable compétent, aucune
page publique ne doit affirmer qu’une AIPD a été réalisée ou qu’elle est
inutile.
