# Chaîne logicielle (issue #37)

Contrôles reproductibles, locaux ou GitHub-native. Aucun envoi du code ou
des données vers un SaaS non approuvé (pas de Snyk/Socket/Semgrep Cloud).
Les alertes restent dans l’onglet Security du dépôt (pas de tableau de bord
public).

## Seuils bloquants

| Scanner | Périmètre | Seuil | Indisponibilité |
| --- | --- | --- | --- |
| `pnpm audit --prod` | dépendances production | **high et critical** | échec (exit 2) |
| Trivy `fs` | lockfile / manifeste | HIGH, CRITICAL (corrigées) | échec |
| Trivy `image` | paquets OS de l’image `FROM` | **CRITICAL** corrigées (HIGH rapportés) | échec |
| Gitleaks | historique git + PR | toute fuite hors allowlist d’exemples | échec |
| CodeQL | JS/TS, pack `security-extended` | SARIF produit (upload GitHub = réglage humain) | échec si pas de SARIF |
| Pins Actions | `.github/workflows` | SHA 40 hex | échec |

Les sévérités moderate/low ne bloquent pas le merge. Délais de correction
visés : critical 7 j, high 14 j, moderate 60 j, low 120 j.

## Exceptions

Fichier `security/exceptions.json`. Chaque entrée est **nommée** (id GHSA),
justifiée, compensée et **datée**. Pas de `continue-on-error` global, pas de
`--audit-level none`. Une exception expirée échoue la CI.

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",
  "package": "exemple",
  "severity": "high",
  "reason": "pourquoi on n’a pas encore patché",
  "compensation": "mesure équivalente",
  "expires": "2026-12-31",
  "scanner": "pnpm-audit"
}
```

## Mise à jour des outils

`security/tool-pins.lock` : versions + sha256 de Gitleaks/Trivy et SHA des
Actions. Dependabot ouvre des PR groupées (npm / actions / docker) chaque
lundi ; la CI (lint, tests, build, supply-chain) doit passer avant merge.

## SBOM

CycloneDX généré par Trivy (`artifacts/sbom.cdx.json`), conservé 30 jours en
artefact GitHub. Pas d’attestation Sigstore tant que `attestations: write`
n’est pas validé sur le dépôt (résidu). Ne pas y mettre de secret.

## Coordination

- Digests runtime app/MariaDB/Caddy : issue #36.
- Licences / provenance : ticket dédié, hors périmètre.
- Prestataires : issue #30 (pas de nouveau SaaS ici).
- Image Node officielle : HIGH Debian / npm embarqué npm CLI → Dependabot docker + #36.
- Code scanning GitHub (onglet Security) : à activer dans les réglages du dépôt ; le job CodeQL produit déjà un SARIF.
