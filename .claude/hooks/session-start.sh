#!/bin/bash
# SessionStart : active les hooks Git du dépôt, et installe les dépendances dans les sessions cloud.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

git config core.hooksPath .githooks
git config commit.template .gitmessage

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  npm install --no-audit --no-fund
  sha256sum .claude/hooks/session-start.sh package.json package-lock.json > "$hashes" || rm -f "$hashes"
fi

# Garden n'a besoin que de `requests` : ne remplace pas une version déjà fonctionnelle.
if ! python3 -c "import requests" 2>/dev/null; then
  python3 -m pip install --quiet -r LWGarden/src/requirements.txt
fi
