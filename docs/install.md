# Подключение агентов

Подключение делается после деплоя сервиса: до этого отчёты будут копиться в локальной очереди.

## 1. Клиент на машине

```bash
cd ~/dev/tools/chronicle && bun install && bun run link   # chronicle в ~/.local/bin
```

`~/.config/chronicle/config.json`:

```json
{
  "serverUrl": "https://<адрес сервиса>",
  "token": "<токен>",
  "host": "laptop",
  "extractModel": { "claude-code": "haiku", "pi": "deepseek/deepseek-flash" }
}
```

`host` — имя контура: `laptop` на ноутбуке, `kalki-server` на сервере. `extractModel` необязателен: по умолчанию у каждого адаптера своя дешёвая модель.

Проверка: `chronicle search "bun: command not found"`.

## 2. Claude Code

- Хук завершения сессии — содержимое `integrations/claude-code/settings.json` добавить в `~/.claude/settings.json`. Итог сессии формируется при любом её завершении: `/clear` (новая сессия), выход, `/logout`.
- Скил recall: `ln -s ~/dev/tools/chronicle/integrations/skills/recall ~/.claude/skills/recall`. Отдельного `learn` нет — знания извлекаются при завершении сессии.

## 3. pi

В `~/.pi/agent/settings.json` → `packages`: добавить `../../dev/tools/chronicle/integrations/pi` (на сервере — абсолютный путь `/srv/chronicle/integrations/pi`). Пакет даёт `/finish` (`/finish exit` — с выходом) и скил recall.

В глобальные правила агента (`~/.pi/agent/AGENTS.md`) — раздел о chronicle: когда вызывать recall, как формируется итог сессии.

## MCP (для агентов с поддержкой MCP)

`https://chronicle.u7-hub.kz/mcp` — Streamable HTTP, заголовок `Authorization: Bearer <токен>`. Инструменты: `knowledge_search` (дословный текст ошибки; `project_remote` — git remote текущего репо для записей проекта), `knowledge_get`, `knowledge_used`. Только чтение и учёт пользы: итоги сессий через MCP не принимаются.

Claude Code (если нужен MCP вместо CLI):

```bash
claude mcp add --transport http chronicle https://chronicle.u7-hub.kz/mcp --header "Authorization: Bearer <токен>"
```

agy: `agy mcp add …` с теми же адресом и заголовком.

## 4. agy

Не подключён: формат логов и способ получить ID диалога не проверены (agy не авторизован на машине разработки). См. docs/agent-contract.md.

## Диагностика

- `~/.local/state/chronicle/finish.log` — лог фоновых finish;
- `chronicle outbox list` — неотправленные отчёты; `chronicle outbox flush` — отправить;
- `~/.local/state/chronicle/outbox/rejected/` — отклонённые сервером отчёты с причинами.
