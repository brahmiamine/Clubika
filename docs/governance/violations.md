# Procédure de violation de données — brouillon opérationnel

Référence CNIL : https://www.cnil.fr/fr/services-en-ligne/notifier-une-violation-de-donnees-personnelles

Le logiciel **n’envoie pas** la notification art. 33. L’exploitant tient un
registre hors application.

## Collecte des faits (immédiat)

- Horodatage, systèmes touchés (MariaDB, fichiers secrets, dumps, journaux).
- Catégories de personnes et de données, estimation du volume.
- Mesure de confinement (rotation des secrets, révocation de sessions,
  désactivation d’un kill switch #30).
- Corrélation technique : logs structurés et expurgés (#31), pas de copie
  d’e-mails ou de jetons dans le ticket.

## Qualification du risque

Un humain décide si la violation est susceptible d’engendrer un risque pour
les droits et libertés. Clubika ne calcule pas ce risque.

## Délais

- Notification CNIL : 72 h **lorsque l’art. 33 l’exige** — l’application ne
  déclenche pas ce délai.
- Information des personnes : selon l’art. 34, décision humaine.

## Responsabilités

À figer après le choix responsable / sous-traitant
([roles-responsabilites.md](./roles-responsabilites.md)). Le sous-traitant
informe le responsable sans délai injustifié ; le responsable notifie
l’autorité s’il y est tenu.

## Preuve

Conserver : décision, destinataires, horodatage, mesures. Ne pas conserver
les contenus personnels au-delà de la nécessité de la qualification.
