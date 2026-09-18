# Flux sortants — barrière commune (issue #30)

Tous les appels réseau vers un prestataire sont **désactivés** tant que le
drapeau d’environnement correspondant n’est pas posé à `true` (WhatsApp :
`WHATSAPP_PROVIDER=meta|webhook`). Les URL publiques de démonstration
(OSRM Project, Open-Meteo, proxy de logos ouvert) **ne sont jamais** des
valeurs par défaut de production.

SportCorico reste traité par #4/#5 ; WhatsApp par #17. Cette barrière ne
présume pas leur autorisation juridique.

## Kill switches

| Intégration | Variable | Données transmises |
| --- | --- | --- |
| SMTP | `SMTP_ENABLED=true` | e-mail, sujet, texte |
| WhatsApp | `WHATSAPP_PROVIDER=meta` ou `webhook` | numéro, texte |
| Web Push | `WEB_PUSH_ENABLED=true` | titre, message, `eventId` |
| Météo | `OPEN_METEO_ENABLED=true` **et** `OPEN_METEO_FORECAST_URL` | coordonnées |
| Routage | `ROUTING_ENABLED=true` **et** `ROUTING_API_BASE_URL` | lat/lon |
| Proxy logos | `LOGO_PROXY_ENABLED=true` **et** `LOGO_PROXY_ALLOWED_HOSTS` | octets d’image |
| SportCorico | `SPORTCORICO_SYNC_ENABLED=true` | calendrier officiel |

Désactivation globale immédiate : retirer le drapeau, redémarrer. Aucune
donnée club n’est effacée.

## SMTP / TLS

- Port 465 ou `SMTP_SECURE=true` : TLS implicite.
- Sinon (typiquement 587) : STARTTLS obligatoire (`requireTLS`), certificat
  vérifié (`rejectUnauthorized`), TLS ≥ 1.2.
- `SMTP_ALLOW_INSECURE=true` n’est honoré **que hors production**.
- Allowlist optionnelle : `SMTP_ALLOWED_HOSTS`.

## Réinitialisation du mot de passe

Le webhook qui recevait e-mail + URL contenant le jeton brut est **supprimé**.
L’envoi se fait uniquement par SMTP vers l’adresse du compte, si SMTP est
activé. En développement, l’API peut encore renvoyer `resetUrl` dans la
réponse JSON (jamais en production).

## Activation (bloquée)

Ne pas activer en production avant :

- un contrat / DPA avec le prestataire ;
- la mise à jour des pages légales et de la liste des sous-traitants (#12) ;
- le go/no-go humain (#40).

Ce fichier n’établit ni le rôle RGPD (responsable / sous-traitant) ni la
base légale. Les champs `legalReview: required` du registre sont factuels.
