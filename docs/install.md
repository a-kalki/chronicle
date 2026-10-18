# Установка

Порядок: сервис (один на всех) → клиент на каждой машине → агенты. Клиент без сервиса работает, но отчёты копятся в локальной очереди, а поиск знаний недоступен.

Ниже `<chronicle>` — каталог клона репозитория, `<адрес>` — URL сервиса.

## 0. Требования

- **Bun** 1.4 (на 1.3 не читается `bun.lock` — ставить зависимости без него, как в `scripts/deploy.sh`);
- **git** — коммиты и проекты определяются по нему;
- **Linux**. macOS не проверялся; agy — только Linux; Windows — нет;
- **LLM с OpenAI-совместимым API** для сервиса (курирование знаний): по умолчанию DeepSeek;
- агенты, проверенные вживую: Claude Code 2.1, pi 1.3, agy 1.4.

```bash
git clone https://github.com/a-kalki/chronicle.git <chronicle>
cd <chronicle> && bun install && bun run check
```

## 1. Сервис

Один на всех людей и машины. Запуск: `bun src/http/main.ts [путь к chronicle.server.json]` (по умолчанию `./chronicle.server.json`, его может не быть).

`chronicle.server.json` (все поля необязательны):

```json
{
  "port": 4517,
  "hostname": "127.0.0.1",
  "dbPath": "./data/chronicle.db",
  "timezone": "Europe/Moscow",
  "llm": { "model": "deepseek/deepseek-flash", "apiKeyEnv": "DEEPSEEK_API_KEY" }
}
```

Полный список настроек и значения по умолчанию — [spec.md](spec.md) §7. Важное:
- **токены** — `CHRONICLE_TOKENS=человек:токен,человек:токен` (или `tokens` в файле). Человек — slug (`ivan`), токен — любая случайная строка (`openssl rand -hex 24`), удобно по одному на машину. Без токенов сервис не стартует;
- **LLM** — `<провайдер>/<модель>`; провайдеры `deepseek` и `openai` известны, для другого OpenAI-совместимого — `llm.baseUrl`. Ключ — в переменной `llm.apiKeyEnv`. Без ключа сервис не стартует;
- **`timezone`** — граница дня в отчётах; по умолчанию `Asia/Oral`, поменяйте на свой;
- **сеть** — сервис слушает только `127.0.0.1`. Для других машин опубликуйте его через обратный прокси с HTTPS (токен идёт в заголовке открытым текстом). `hostname: "0.0.0.0"` — только в доверенной сети.

Постоянная работа — любой менеджер процессов, например `pm2 start "bun src/http/main.ts" --name chronicle --cwd <chronicle>`. Секреты удобно держать в `<chronicle>/.env` — Bun читает его сам. Бэкап — копия SQLite: `sqlite3 data/chronicle.db ".backup backup.db"`. Пример целиком (pm2, nginx, бэкап, обновление) — [deploy.md](deploy.md).

Проверка: `curl -s http://127.0.0.1:4517/v1/health`.

## 2. Клиент на машине

```bash
cd <chronicle> && bun run link   # chronicle → ~/.local/bin (должен быть в PATH)
```

`~/.config/chronicle/config.json`:

```json
{
  "serverUrl": "<адрес>",
  "token": "<токен этой машины>",
  "host": "laptop",
  "extractModel": { "claude-code": "haiku", "pi": "deepseek/deepseek-flash", "agy": "gemini-3.8-flash-low" }
}
```

- `host` — имя машины-контура (slug): `laptop`, `work-server`;
- `extractModel` необязателен: дешёвая модель для выжимки по агентам, значения выше — по умолчанию. Выжимка идёт на подписке или ключе самого агента;
- переменные `CHRONICLE_URL`, `CHRONICLE_TOKEN`, `CHRONICLE_HOST` важнее файла.

Коммиты в отчёт попадают по `git config user.email` — он должен совпадать с автором коммитов.

Проверка: `chronicle search "bun: command not found"` (на пустой базе — «Ничего не найдено.»).

## 3. Claude Code

- Хук завершения и строка статуса — содержимое `integrations/claude-code/settings.json` добавить в `~/.claude/settings.json`. Итог формируется при любом завершении сессии: `/clear`, выход, `/logout`.
- Строка статуса показывает результат фонового итога: `⏳` — формируется, `✓ 12:40 «итог…» +2` — отправлен (+знаний), `✖` — ошибка (см. `finish.log`), `⇡N` — отчёты в очереди.
- Скил recall: `ln -s <chronicle>/integrations/skills/recall ~/.claude/skills/recall`.

## 4. pi

В `~/.pi/agent/settings.json` → `packages`: добавить `<chronicle>/integrations/pi` (абсолютный путь или относительно `~/.pi/agent`). Пакет даёт `/finish` (итог и новая сессия; `/finish exit` — с выходом) и скил recall. Результат придёт уведомлением в новой сессии.

## 5. agy

Итог — сам, как в Claude Code: при `/clear`, `/resume` на другой диалог и выходе из agy.

- Хуки `SessionStart` и `Stop` → `chronicle agy-hook`: `ln -s <chronicle>/integrations/agy/hooks.json ~/.gemini/config/hooks.json` (если там уже есть свои хуки — объединить вручную).
- Строка статуса — в `~/.gemini/antigravity-cli/settings.json` (под стандартной строкой agy):
  ```json
  "statusLine": { "type": "command", "command": "chronicle statusline --agent agy --no-model", "stack_with_default": true }
  ```
- Скил recall: `ln -s <chronicle>/integrations/skills/recall ~/.gemini/config/skills/recall`.

## 6. Правила агента

В глобальные правила агента (`~/.claude/CLAUDE.md`, `~/.pi/agent/AGENTS.md`, `~/.gemini/GEMINI.md`) — короткий раздел: при неожиданной ошибке — `chronicle search "<дословный текст>"` до починки; итог сессии формируется сам, отдельно записывать знания не нужно.

## MCP (необязательно)

`<адрес>/mcp` — Streamable HTTP, заголовок `Authorization: Bearer <токен>`. Инструменты: `knowledge_search` (дословный текст ошибки; `project_remote` — git remote текущего репо), `knowledge_get`, `knowledge_used`. Только чтение и учёт пользы: итоги сессий через MCP не принимаются.

```bash
claude mcp add --transport http chronicle <адрес>/mcp --header "Authorization: Bearer <токен>"
```

agy: `agy mcp add …` с теми же адресом и заголовком.

## Ограничения

**Общие**
- Нужен свой сервис: готового общего нет.
- Доступа по ролям нет: любой токен видит знания и работу всех людей.
- Отчётность минимальная: `chronicle report day` и `GET /v1/facts`; веб-интерфейса нет.
- Что уходит на сервис: итог и результаты сессии, фокусы и время ходов, метки активности, коммиты (хеш, тема, время), пути изменённых файлов, remote и локальные пути проектов, кандидаты в знания. Текст реплик и код — нет. Выжимку делает модель агента и видит всю сессию (тот же провайдер, что и сама работа); кандидаты в знания видит LLM сервиса.
- Выжимка тратит токены дешёвой модели агента на каждое завершение сессии; сессии без новых реплик человека пропускаются.
- Коммиты — только автора с `git config user.email`, только из репозитория запуска и тех, которых коснулись инструменты агента.

**Claude Code**
- Итог зависит от хука `SessionEnd`: если терминал убит, хук может не сработать — тогда `chronicle finish --agent claude-code --session <id>`.
- Откат (`Esc Esc`) не проверен: брошенные ветки могут не попасть в итог.

**pi**
- Итог — только по `/finish`; выход без него итога не даёт (вручную — `chronicle finish --agent pi --session <id>`).

**agy**
- Только Linux: pid agy ищется через `/proc`, выход ловит GNU `tail --pid`.
- Опирается на внутренние форматы agy (SQLite диалога, лог, `cache/last_conversations.json`), а не на публичный API: проверено на agy 1.4, обновление agy может сломать выжимку.
- Убит `kill -9` или выключена машина — итог последнего диалога придёт при следующем запуске agy.
- Удалённые копии диалогов agy восстанавливает в своём списке из внутреннего хранилища: в `/resume` они не видны, но копятся.
- Уже запущенный agy подхватывает хуки и строку статуса только после перезапуска.

## Диагностика

- `~/.local/state/chronicle/finish.log` — лог фоновых итогов;
- `chronicle outbox list` — неотправленные отчёты; `chronicle outbox flush` — отправить;
- `~/.local/state/chronicle/outbox/rejected/` — отклонённые сервисом отчёты с причинами;
- `~/.local/state/chronicle/agy/` — текущий диалог и сторож по процессам agy.
