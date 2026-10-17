# chronicle

Сервис итогов рабочих сессий агентов (Claude Code, pi, agy) на любых машинах: знания-ловушки, сделанная работа, активное время.

- [Спецификация](docs/spec.md)
- [Контракт агента](docs/agent-contract.md) — требования к адаптеру любого агента
- [План](docs/plan.md)

```bash
bun install
bun run check   # lint + typecheck + тесты

# сервис (настройки — chronicle.server.json, токены можно через CHRONICLE_TOKENS)
CHRONICLE_TOKENS=<токен> bun src/http/main.ts

# клиент (~/.config/chronicle/config.json: serverUrl, token, host)
bun src/cli/main.ts help
```
