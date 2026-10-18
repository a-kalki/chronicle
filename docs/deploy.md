# Развёртывание (kalki-server)

| Что | Где |
|---|---|
| Код | `/srv/chronicle` (git clone, ветка `main`) |
| Секреты | `/srv/chronicle/.env` (600): `DEEPSEEK_API_KEY`, `CHRONICLE_TOKENS` (`человек:токен,человек:токен`) — Bun читает его сам |
| БД | `/srv/chronicle/data/chronicle.db` (SQLite, WAL) |
| Процесс | pm2 `chronicle`: `bun src/http/main.ts`, слушает `127.0.0.1:4517` |
| Публикация | nginx `/etc/nginx/sites-available/chronicle.u7-hub.kz` → `https://chronicle.u7-hub.kz` (сертификат certbot) |
| Бэкап | `backup.contract` + `scripts/backup.sh` → `db-backups/`; обход — backup-orchestrator server-ops, вынос — offsite-backup |
| Мониторинг | health-check server-ops: `HEALTH_INTERNAL_SERVICES` в `~/server-ops/config/common.env` (порт 4517 + pm2 `chronicle`) |
| Клиент на сервере | `~/.config/chronicle/config.json` (`serverUrl: http://127.0.0.1:4517`, `host: kalki-server`), `~/.local/bin/chronicle` |

Токены: по одному на контур (ноутбук, сервер), каждый сопоставлен человеку — любой можно отозвать, убрав из `CHRONICLE_TOKENS` и перезапустив процесс.

## Обновление

```bash
ssh kalki_server
cd /srv/chronicle && bash scripts/deploy.sh
```

## Оговорки

- Bun на сервере (1.3.x) не читает `bun.lock` от Bun 1.4 — `deploy.sh` ставит зависимости в обход lockfile. Обновлять Bun на сервере — только вместе с остальными сервисами.
- В неинтерактивной ssh-сессии (`ssh kalki_server 'chronicle …'`) нет `~/.local/bin` и `~/.bun/bin` в PATH — вызывать через `bash -ic` или по полным путям. Агенты в интерактивных сессиях этим не затронуты.
- Автозапуск pm2 после перезагрузки сервера не настроен (общая особенность сервера, не только chronicle).
