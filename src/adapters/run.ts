/** Запуск внешней команды агента с таймаутом; подменяется в тестах. */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

export type Runner = (cmd: string[], options: RunOptions) => Promise<RunResult>;

/** Выжимка не должна идти дольше — иначе считаем агента зависшим */
export const EXTRACT_TIMEOUT_MS = 10 * 60_000;

/**
 * Окружение для неинтерактивного запуска агента: метка CHRONICLE_EXTRACT защищает от рекурсии
 * (хук завершения дочерней сессии снова вызвал бы finish).
 */
export function extractEnv(drop: string[] = []): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CHRONICLE_EXTRACT: '1' };
  for (const key of drop) delete env[key];
  return env;
}

export const runCommand: Runner = async (cmd, { cwd, env, timeoutMs }) => {
  const proc = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};
