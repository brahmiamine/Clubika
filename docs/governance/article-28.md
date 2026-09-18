# Trame d’accord de sous-traitance (art. 28) — à faire rédiger

Ce fichier n’est **pas** un contrat. Il liste les clauses que l’art. 28
exige, pour qu’un juriste les rédige une fois le rôle choisi
([roles-responsabilites.md](./roles-responsabilites.md)).

## Clauses à couvrir

1. Instructions documentées du responsable.
2. Confidentialité des personnes autorisées.
3. Mesures de sécurité (art. 32) alignées sur le code : isolation tenant,
   chiffrement chat/SMTP si `APP_ENCRYPTION_KEY`, sessions hashées, CSP/HSTS.
4. Recours à des sous-traitants ultérieurs : liste = kill switches #30 ;
   information préalable ; flux identiques aux garanties.
5. Assistance pour les droits des personnes (#22, #26).
6. Assistance pour les notifications de violation (voir [violations.md](./violations.md)).
7. Audits et inspections : modalités à définir (pas d’outil d’audit client
   dans le produit).
8. Restitution / suppression en fin de contrat, **y compris les sauvegardes**
   (une purge SQL ne rétroagit pas sur un dump, `docs/retention.md`).
9. Sort des données d’offboarding club (#25) et de fermeture de compte (#11).

## Blocage

Ne pas faire signer cette trame telle quelle. Pas de nom de parties, pas de
loi applicable inventée, pas de tarif.
