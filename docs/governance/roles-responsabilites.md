# Qualification des rôles (art. 4, 26, 28) — non tranchée

Issue #12. Clubika n’affiche aucun de ces modèles comme retenu.

## Hypothèse A — Club responsable, éditeur sous-traitant

Le club décide des finalités (qui est affecté, quelles fiches sans compte,
quels canaux de notification). L’éditeur fournit le logiciel et l’hébergement
éventuel, sur instruction. Un contrat art. 28 est alors nécessaire
(voir [article-28.md](./article-28.md)).

## Hypothèse B — Responsabilité conjointe (art. 26)

Certaines finalités (comptes plateforme, télémétrie d’exploitation, modèle
multi-tenant) pourraient être décidées conjointement. Cela exigerait un
arrangement précisant les parts de responsabilité et le point de contact
unique. **Non évalué, non signé.**

## Ce que le code ne permet pas de conclure

- L’isolation `clubId` décrit une séparation technique, pas un rôle juridique.
- La page plateforme `/plateforme` donne un pouvoir d’administration transverse :
  cela pèse sur l’hypothèse B, sans la trancher.
- WhatsApp, SMTP, SportCorico, météo et routage sont des sous-traitants
  *ultérieurs possibles*, uniquement s’ils sont activés (#30).

**Blocage :** un professionnel compétent choisit A, B ou un mélange par
finalité, puis #40 valide avant données réelles.
