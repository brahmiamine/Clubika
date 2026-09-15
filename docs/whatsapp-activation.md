# WhatsApp — activation explicite (issue #17)

Le canal WhatsApp est **désactivé par défaut**. Les secrets Meta ou une URL de
webhook **ne l’allument pas** tant que `WHATSAPP_PROVIDER` n’est pas posé
explicitement.

## Activation (bloquée tant que la revue contractuelle n’est pas faite)

Coordonner avec #12 (pages légales, liste des prestataires) et #40 (go/no-go
humain). Ne pas activer en production avant :

- un contrat / DPA avec le prestataire (Meta Platforms Ireland Ltd pour Cloud
  API, ou l’opérateur du webhook) ;
- la mise à jour de la politique de confidentialité et de la liste des
  sous-traitants ;
- la vérification des règles [WhatsApp Business](https://business.whatsapp.com/policy)
  (templates approuvés pour les messages initiés par l’entreprise, fenêtre de
  conversation, interdiction de contenus non sollicités hors template).

Puis, sur le serveur uniquement :

```bash
# Meta Cloud API
WHATSAPP_PROVIDER=meta
WHATSAPP_META_PHONE_NUMBER_ID=...
WHATSAPP_META_ACCESS_TOKEN=...
WHATSAPP_META_GRAPH_VERSION=vXX.X
WHATSAPP_META_TEMPLATE_NAME=planning_notification
WHATSAPP_META_TEMPLATE_LANGUAGE=fr

# ou webhook générique
WHATSAPP_PROVIDER=webhook
NOTIFICATION_WHATSAPP_WEBHOOK_URL=https://…
NOTIFICATION_WHATSAPP_WEBHOOK_TOKEN=…

# optionnel : ajouter eventType / eventId / urgence au JSON webhook
# (identifiants d’événement, pas de noms). Nécessaire seulement si le
# prestataire route des templates. Désactivé par défaut.
# WHATSAPP_WEBHOOK_INCLUDE_EVENT_CONTEXT=true
```

Redémarrer l’application. Chaque utilisateur doit encore cocher l’opt-in
WhatsApp dans **Notifications**. Sans numéro de profil, rien n’est envoyé.

## Données transmises

| Destinataire | Contenu |
| --- | --- |
| Meta Graph | numéro E.164, titre et corps (ou paramètres de template) |
| Webhook | numéro et texte ; `eventType` / `eventId` / `urgency` seulement si le drapeau ci-dessus vaut `true` |

Les journaux techniques n’incluent ni le numéro ni le contenu.

## Désactivation globale immédiate

1. Vider ou supprimer `WHATSAPP_PROVIDER` (ou le mettre à `disabled`).
2. Redémarrer l’application.
3. Les envois s’arrêtent même si des utilisateurs restent opt-in. L’opt-in en
   base est forcé à `false` au prochain enregistrement des préférences.

Aucune auto-détection : laisser les variables `WHATSAPP_META_*` ou l’URL de
webhook en place ne réactive pas le canal.

## Rôle RGPD (à confirmer par #12 / conseil)

Tant que le canal est désactivé, aucun traitement WhatsApp n’a lieu.
En cas d’activation Meta, Meta est un prestataire ultérieur ; le responsable
du traitement (club et/ou éditeur, selon le modèle retenu dans #12) doit
documenter finalité, base (consentement de l’opt-in), localisation et
transferts. Ce fichier ne constitue pas une analyse juridique.
