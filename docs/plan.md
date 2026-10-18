# План реализации

Каждая задача — TDD: сначала тест, потом реализация. Этап завершается работающим вертикальным срезом.

## Этап 1. Ядро и локальный сервис

- [x] Каркас: Bun, TypeScript strict, Biome, `bun test`
- [x] `contract/`: valibot-схемы `SessionReport` и `ExtractResult`, генерация JSON Schema (`@valibot/to-json-schema`), версия `v1`
- [x] Домен: нормализация git remote, идентификация проекта, активное время по меткам и порогу, схожесть записей (перенос из pi-chronicle)
- [x] SQLite: миграции, репозитории
- [x] Use case `submitReport`: валидация, идемпотентность по `(agent, sessionId, seq)`, одна транзакция
- [x] Use cases `search`, `get`, `recordUsage`
- [x] HTTP API `/v1` с bearer-токеном
- [x] CLI `chronicle`: `search`, `show`, `used`, `report submit`, `outbox`
- [x] Outbox: запись при недоступности, отправка при следующем вызове

## Этап 2. Курирование знаний

- [x] LLM-клиент OpenAI-совместимый; провайдер и модель из настроек (по умолчанию `deepseek/deepseek-flash`)
- [x] Use case `curate`: поиск похожих → решение LLM (`create` / `merge` / `discard`) → применение и история
- [x] Фоновая очередь курирования в сервисе
- [x] Архивирование неиспользуемых записей
- [x] Промпт `prompts/extract.md`: только ловушки и факты, критерии отсева

## Этап 3. Адаптеры

- [x] Общий хелпер `chronicle finish`: коммиты за интервал, сборка отчёта, watermark, фон, режим хука
- [x] Claude Code: разбор JSONL, хук `SessionEnd`, скил recall через CLI
- [x] pi: пакет `integrations/pi` (`/finish`, recall) вместо pi-chronicle
- [ ] agy: отложено — agy не авторизован, формат логов и ID диалога не проверить; ждёт решения пользователя
- [ ] Подключение агентов на машинах (`docs/install.md`) — после деплоя

## Этап 4. Миграция и деплой

- [x] Деплой на сервер под pm2, токены, бэкап БД (контракт server-ops), health-check, nginx + HTTPS (`docs/deploy.md`)
- [x] Клиенты на ноутбуке и сервере смотрят в один сервис
- [x] Импорт из pi-chronicle: 30 ловушек/фактов из 53 записей, 54 сессии worklog; pi-chronicle удалён
- [x] Подключение агентов: Claude Code и pi на ноутбуке, pi на сервере (`docs/install.md`)

## Этап 5. MCP

- [x] MCP-эндпоинт `/mcp` (Streamable HTTP) только для чтения и учёта пользы: `knowledge_search`, `knowledge_get`, `knowledge_used`; проверен клиентом Claude Code

## Этап 6. Модель работы v2: «что сделано / сколько работал»

Спека — `spec.md`, модель — `data-and-api.md` §2–§3, контракт — `agent-contract.md` (A10, v2). Повод: проект определялся по `cwd` запуска, работа в другом репо терялась (сессия 4e6bfd2b 2026-10-17: 27 коммитов chronicle не учтены).

- [ ] Контракт v2: `contract/v2.ts` (`SessionReport`, `ExtractResult` с эпизодами), v1 остаётся; JSON Schema выжимки — из v2
- [ ] Домен: проект хода по путям с весами и наследованием (поверх `detectProject`); объединение и пересечение интервалов (рядом с `activeMs`)
- [ ] Миграция SQLite: `persons`, `turns`, `outcomes`, `project_id` у `commits`/`segment_files`, `person`/`launch_project` у `sessions`, `superseded` у `segments`; токены → человек в настройках
- [ ] `submitReport` v2 и v1 (как сегмент без ходов); `replace` — пометка прежних сегментов сессии `superseded`
- [ ] Адаптер Claude Code: ходы и пути из JSONL (`tool_use`: `file_path`/`path`/`notebook_path`, `cd` в Bash)
- [ ] Адаптер pi: ходы и пути из JSONL сессии
- [ ] `collectCommits` по всем затронутым репо; сборка отчёта v2 в `finish`
- [ ] Промпт `prompts/extract.md`: эпизоды по номерам ходов, переиспользование недавних фокусов
- [ ] `chronicle replay` (выжимка без знаний, `replace`)
- [ ] `GET /v1/facts` и `chronicle report day` (время `X ч (паралл. Y ч)`, эпизоды, результаты, коммиты)
- [ ] Выкатка: копия БД на сервере → деплой → обновление клиентов (ноутбук, сервер) → `replay` живых сессий
- [ ] Проверка e2e: `chronicle report day 2026-10-17` — chronicle и u7-school раздельно, 27 + 3 коммита, пересечение с pi-сессией в параллельном времени

## Потом

- Пересборка курированной базы по всем кандидатам (при смене правил курирования) — отложено до реальной потребности: сырые кандидаты сохраняются, вопрос переноса статистики пользы решим тогда
- Вспомогательные метрики (`spec.md` §4) поверх `GET /v1/facts`; Customer — по потребности, возможно во внешнем сервисе
- Разграничение доступа (команда, клиенты)
