/** Настройки клиента: ~/.config/chronicle/config.json, переменные окружения важнее файла. */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

const ClientConfig = v.object({
  serverUrl: v.pipe(v.string(), v.url('serverUrl: ожидается URL сервиса')),
  token: v.pipe(v.string(), v.minLength(1, 'token: не задан')),
  /** Имя машины-контура: laptop, kalki-server */
  host: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, 'host: ожидается slug')),
  outboxDir: v.string(),
  /** Состояние finish по сессиям и лог фоновых запусков */
  stateDir: v.string(),
  /** Дешёвая модель для выжимки по агентам (этап адаптеров) */
  extractModel: v.optional(v.record(v.string(), v.string()), {}),
});

export type ClientConfig = v.InferOutput<typeof ClientConfig>;

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config/chronicle/config.json');

export function loadClientConfig(env: Record<string, string | undefined>): ClientConfig {
  const path = env.CHRONICLE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const file = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  const merged = {
    ...file,
    serverUrl: env.CHRONICLE_URL ?? file.serverUrl,
    token: env.CHRONICLE_TOKEN ?? file.token,
    host: env.CHRONICLE_HOST ?? file.host,
    outboxDir: env.CHRONICLE_OUTBOX ?? file.outboxDir ?? join(homedir(), '.local/state/chronicle/outbox'),
    stateDir: env.CHRONICLE_STATE ?? file.stateDir ?? join(homedir(), '.local/state/chronicle'),
  };
  const res = v.safeParse(ClientConfig, merged);
  if (!res.success) {
    throw new Error(`настройки клиента (${path}): ${res.issues.map((i) => i.message).join('; ')}`);
  }
  return res.output;
}
