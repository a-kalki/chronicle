#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# backup.sh — контракт бэкапа chronicle (по образцу u7-hub).
#
# Хранилище — SQLite `data/chronicle.db` (WAL). Снимок делается через
# `VACUUM INTO` (Bun-бэкенд server-ops): консистентная копия при живом писателе.
#
# Результат: db-backups/<UTC-время>-<причина>/manifest.json + data/chronicle.db
#
# Коды возврата (контракт):
#   0  — снимок создан
#   10 — пропущено (нет изменений с прошлого снимка)
#   1  — ошибка
#
# Использование:
#   bash scripts/backup.sh [причина]        # причина: scheduled|pre-deploy|manual|...
#   bash scripts/backup.sh pre-deploy --force
#   bash scripts/backup.sh manual --name=pre-migration   # именованный (protected)
#   bash scripts/backup.sh --list
#   bash scripts/backup.sh --prune
#   bash scripts/backup.sh --verify db-backups/<снимок>
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Bun может не быть в PATH у cron — добавляем типовое место.
export PATH="${HOME}/.bun/bin:${PATH}"

SDK_DIR="${BACKUP_SDK_DIR:-${HOME}/server-ops}"
# shellcheck source=/dev/null
source "${SDK_DIR}/lib/backup-contract.sh"

SERVICE="chronicle"
TYPE="sqlite"
BACKUP_DIR="db-backups"
SOURCE="${DB_PATH:-data/chronicle.db}"
REASON="scheduled"
FORCE=0
PROTECTED=0

usage() { sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; }

# ── Разбор аргументов ──────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)   usage; exit 0 ;;
    --force)     FORCE=1 ;;
    --name)      shift; REASON="${1:-named}"; PROTECTED=1; FORCE=1 ;;
    --name=*)    REASON="${1#--name=}"; PROTECTED=1; FORCE=1 ;;
    --list)
      shopt -s nullglob
      for d in "${BACKUP_DIR}"/*/; do
        [ -f "${d}manifest.json" ] && printf '%s\n' "${d%/}"
      done
      exit 0
      ;;
    --prune)
      bc_begin --service "$SERVICE" --type "$TYPE" --backup-dir "$BACKUP_DIR" \
               --source "$SOURCE" --reason prune >/dev/null
      bc_prune 7 4 6
      exit 0
      ;;
    --verify)
      shift
      snap="${1:-}"
      [ -n "$snap" ] || { echo "укажи каталог снимка: --verify db-backups/<снимок>" >&2; exit 1; }
      if bc_verify_snapshot "$snap"; then
        echo "✅ verify ok: $snap"
      else
        echo "❌ verify failed: $snap" >&2
        exit 1
      fi
      exit 0
      ;;
    -*) echo "неизвестная опция: $1" >&2; usage >&2; exit 1 ;;
    *)  REASON="$1" ;;
  esac
  shift
done

if [ ! -f "$SOURCE" ]; then
  echo "❌ Источник не найден: ${PROJECT_ROOT}/${SOURCE}" >&2
  exit 1
fi

# ── Решение: создавать или пропустить ──────────────────────────────────────
bc_begin --service "$SERVICE" --type "$TYPE" --backup-dir "$BACKUP_DIR" \
         --source "$SOURCE" --reason "$REASON" \
         --trigger "${BC_TRIGGER:-service}" \
         --max-age-hours 26 --min-interval-min 60

[ "$FORCE" = 1 ] && BC_STATE="create"

if [ "$BC_STATE" = "skip" ]; then
  echo "⏭️  Пропуск: ${SOURCE} не менялся с прошлого снимка"
  exit 10
fi

# ── Снимок ─────────────────────────────────────────────────────────────────
SNAP="$(bc_new_snapshot)"
export BC_PROTECTED="$PROTECTED"
bun run "${SDK_DIR}/lib/backends/sqlite.ts" \
  --db "$SOURCE" --out "${SNAP}/data/$(basename "$SOURCE")" >/dev/null
bc_finalize "$SNAP" >/dev/null

if ! bc_verify_snapshot "$SNAP"; then
  echo "❌ verify не прошёл для ${SNAP}" >&2
  exit 1
fi

echo "✅ Бэкап создан: ${SNAP} (protected=${PROTECTED})"
