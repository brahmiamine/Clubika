#!/usr/bin/env bash
# Télécharge un outil pinné (sha256) ou échoue si le miroir est indisponible (issue #37).

set -euo pipefail

LOCK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/security/tool-pins.lock"

load_lock() {
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    export "${line?}"
  done < "$LOCK"
}

fail_unavailable() {
  echo "[supply-chain] Outil ou base indisponible : $*" >&2
  exit 2
}

install_gitleaks() {
  load_lock
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "$GITLEAKS_URL" -o "${tmp}/${GITLEAKS_TARBALL}" || fail_unavailable "téléchargement gitleaks"
  echo "${GITLEAKS_SHA256}  ${tmp}/${GITLEAKS_TARBALL}" | sha256sum -c - || fail_unavailable "checksum gitleaks"
  tar -xzf "${tmp}/${GITLEAKS_TARBALL}" -C "$tmp" gitleaks
  install -m 0755 "${tmp}/gitleaks" /usr/local/bin/gitleaks
  rm -rf "$tmp"
  gitleaks version
}

install_trivy() {
  load_lock
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "$TRIVY_URL" -o "${tmp}/${TRIVY_TARBALL}" || fail_unavailable "téléchargement trivy"
  echo "${TRIVY_SHA256}  ${tmp}/${TRIVY_TARBALL}" | sha256sum -c - || fail_unavailable "checksum trivy"
  tar -xzf "${tmp}/${TRIVY_TARBALL}" -C "$tmp" trivy
  install -m 0755 "${tmp}/trivy" /usr/local/bin/trivy
  rm -rf "$tmp"
  trivy version
}

cmd="${1:-}"
case "$cmd" in
  gitleaks) install_gitleaks ;;
  trivy) install_trivy ;;
  *)
    echo "Usage : $0 gitleaks|trivy" >&2
    exit 1
    ;;
esac
