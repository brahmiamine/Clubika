# Registre des traitements (brouillon art. 30)

Source produit : `app/lib/compliance/legal-notice.ts` (`PROCESSING_INVENTORY`)
et `docs/retention.md`. Les durées sont des **paramètres produit**, pas une
obligation légale.

Pour chaque finalité, la **base juridique n’est pas renseignée**.

## Prestataires / sous-traitants ultérieurs possibles

| Service | Kill switch | Données | Statut |
| --- | --- | --- | --- |
| SMTP | `SMTP_ENABLED` | e-mail, sujet, texte | Désactivé par défaut |
| WhatsApp (Meta ou webhook) | `WHATSAPP_PROVIDER` | téléphone, texte | Désactivé + opt-in |
| Web Push | `WEB_PUSH_ENABLED` | titre, message, eventId | Désactivé par défaut |
| Open-Meteo | `OPEN_METEO_ENABLED` | coordonnées | Désactivé par défaut |
| Routage OSRM-compatible | `ROUTING_ENABLED` | lat/lon | Désactivé par défaut |
| Proxy de logos | `LOGO_PROXY_ENABLED` | octets d’image | Désactivé par défaut |
| SportCorico | `SPORTCORICO_SYNC_ENABLED` | calendrier officiel | Désactivé par défaut |
| Hébergeur / backups | hors application | dump MariaDB | Identité : `LEGAL_HOSTING_*` |

Aucune ligne n’est un sous-traitant « autorisé » tant que le DPA et #40
ne sont pas signés. Voir `docs/external-services.md`.

## Catégories de personnes

- Utilisateurs avec compte (admins, arbitres, encadrants, accompagnateurs).
- Personnes sans compte (#26).
- Contacts d’invitation.
- Administrateurs plateforme.

Mineurs : le produit n’a pas de champ d’âge. Si un club inscrit des mineurs,
une réévaluation AIPD est obligatoire (voir [aipd.md](./aipd.md)).

## Droits

Procédures applicatives : `docs/privacy-rights.md`, `docs/account-closure.md`,
`docs/non-account-contacts.md`, `docs/tenant-offboarding.md`.
L’application n’invente pas les délais de réponse.
