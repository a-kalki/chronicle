#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# deploy.sh — обновление chronicle на сервере (запускать в /srv/chronicle).
#
# Шаги: снимок БД pre-deploy → git pull → зависимости → pm2 restart → health.
#
# Зависимости ставятся без bun.lock: Bun на сервере старше, чем у разработчика,
# и не читает его lockfile; диапазоны версий берутся из package.json.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
export PATH="${HOME}/.bun/bin:${PATH}"

if [ -f data/chronicle.db ]; then
  bash scripts/backup.sh pre-deploy --force
fi

git pull --ff-only

lock_tmp="$(mktemp -d)"
mv bun.lock "$lock_tmp/"
trap 'mv "$lock_tmp/bun.lock" . && rmdir "$lock_tmp"' EXIT
bun install --production --no-save

pm2 restart chronicle --update-env
sleep 2
curl -sf http://127.0.0.1:4517/v1/health >/dev/null && echo "✅ chronicle обновлён: $(git log --oneline -1)"
