/** Настройки сервиса: файл chronicle.server.json + переменные окружения. */
import * as v from 'valibot';

const PositiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

const ServerConfig = v.object({
  port: v.optional(PositiveInt, 4517),
  dbPath: v.optional(v.string(), './chronicle.db'),
  tokens: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), []),
  /** Порог простоя по умолчанию при подсчёте активного времени */
  idleGapMinutes: v.optional(PositiveInt, 30),
  /** Через сколько дней без использования запись знаний уходит в архив */
  archiveAfterDays: v.optional(PositiveInt, 120),
  /** LLM курирования знаний: <провайдер>/<модель>; ключ — из переменной apiKeyEnv */
  llm: v.optional(
    v.object({
      model: v.optional(v.string(), 'deepseek/deepseek-flash'),
      apiKeyEnv: v.optional(v.string(), 'DEEPSEEK_API_KEY'),
    }),
    {},
  ),
});

export type ServerConfig = v.InferOutput<typeof ServerConfig>;

export function parseServerConfig(file: unknown, env: Record<string, string | undefined>): ServerConfig {
  const cfg = v.parse(ServerConfig, file);
  const envTokens = (env.CHRONICLE_TOKENS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const tokens = [...cfg.tokens, ...envTokens];
  if (tokens.length === 0) throw new Error('не задан ни один токен (tokens в конфиге или CHRONICLE_TOKENS)');
  return { ...cfg, tokens };
}
