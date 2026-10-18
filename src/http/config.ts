/** Настройки сервиса: файл chronicle.server.json + переменные окружения. */
import * as v from 'valibot';

const PositiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));
const Person = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, 'человек — slug: a-z, 0-9, дефис'));
/** Токен клиента и человек, чьи отчёты приходят с ним */
const Token = v.object({ token: v.pipe(v.string(), v.minLength(1)), person: Person });

const ServerConfig = v.object({
  port: v.optional(PositiveInt, 4517),
  /** Только localhost: наружу сервис публикует nginx */
  hostname: v.optional(v.string(), '127.0.0.1'),
  dbPath: v.optional(v.string(), './data/chronicle.db'),
  tokens: v.optional(v.array(Token), []),
  /** Порог простоя по умолчанию при подсчёте активного времени */
  idleGapMinutes: v.optional(PositiveInt, 30),
  /** Часовой пояс для границы дня в проекциях */
  timezone: v.optional(v.string(), 'Asia/Oral'),
  /** Через сколько дней без использования запись знаний уходит в архив */
  archiveAfterDays: v.optional(PositiveInt, 120),
  /** Период фонового курирования (дополнительно к сигналу после каждого отчёта) */
  curateIntervalSeconds: v.optional(PositiveInt, 300),
  /** LLM курирования знаний: <провайдер>/<модель>; ключ — из переменной apiKeyEnv */
  llm: v.optional(
    v.object({
      model: v.optional(v.string(), 'deepseek/deepseek-flash'),
      apiKeyEnv: v.optional(v.string(), 'DEEPSEEK_API_KEY'),
      baseUrl: v.optional(v.pipe(v.string(), v.url())),
    }),
    {},
  ),
});

export type ServerConfig = v.InferOutput<typeof ServerConfig>;

export function parseServerConfig(file: unknown, env: Record<string, string | undefined>): ServerConfig {
  const cfg = v.parse(ServerConfig, file);
  // CHRONICLE_TOKENS=человек:токен,человек:токен
  const envTokens = (env.CHRONICLE_TOKENS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((pair) => {
      const sep = pair.indexOf(':');
      if (sep < 1) throw new Error('CHRONICLE_TOKENS: ожидается человек:токен через запятую');
      return v.parse(Token, { person: pair.slice(0, sep), token: pair.slice(sep + 1) });
    });
  const tokens = [...cfg.tokens, ...envTokens];
  if (tokens.length === 0) throw new Error('не задан ни один токен (tokens в конфиге или CHRONICLE_TOKENS)');
  return { ...cfg, tokens };
}
