/**
 * Адаптер pi. Лог: ~/.pi/agent/sessions/<каталог>/<время>_<sessionId>.jsonl, первая строка — заголовок с cwd;
 * watermark — число обработанных полных строк.
 * Выжимка: форк во временный каталог сессий (--fork несовместим с --no-session), каталог удаляется.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentAdapter,
  COPIED_HISTORY_SLACK_MS,
  type ExtractOptions,
  type SessionRead,
} from '../finish/adapter.ts';
import { EXTRACT_TIMEOUT_MS, extractEnv, type Runner, runCommand } from './run.ts';

interface LogLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  message?: { role?: string };
}

const ACTORS: Record<string, 'user' | 'agent'> = { user: 'user', assistant: 'agent', toolResult: 'agent' };

/** JSON-объект из ответа модели: без ограждений markdown и текста вокруг */
function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`pi: в ответе нет JSON: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error(`pi: ответ не JSON: ${text.slice(0, 300)}`);
  }
}

export class PiAdapter implements AgentAdapter {
  readonly name = 'pi';
  readonly defaultExtractModel = 'deepseek/deepseek-flash';

  constructor(
    private readonly sessionsDir = join(homedir(), '.pi/agent/sessions'),
    private readonly run: Runner = runCommand,
  ) {}

  private findLog(sessionId: string): string | null {
    if (!existsSync(this.sessionsDir)) return null;
    for (const dir of readdirSync(this.sessionsDir)) {
      const match = readdirSync(join(this.sessionsDir, dir)).find((f) => f.endsWith(`_${sessionId}.jsonl`));
      if (match) return join(this.sessionsDir, dir, match);
    }
    return null;
  }

  readSession(sessionId: string, watermark: unknown | null): SessionRead | null {
    const path = this.findLog(sessionId);
    if (!path) return null;

    // Последняя строка без перевода строки может дописываться прямо сейчас — её не берём
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((raw) => JSON.parse(raw) as LogLine);
    const from = typeof watermark === 'number' ? watermark : 0;

    // Заголовок сессии — момент её создания: в форке всё, что старше, — скопированная история
    const header = lines.find((l) => l.type === 'session');
    const cutoff = header?.timestamp ? Date.parse(header.timestamp) - COPIED_HISTORY_SLACK_MS : 0;
    const events: SessionRead['events'] = [];
    for (const l of lines.slice(from)) {
      const actor = l.type === 'message' ? ACTORS[l.message?.role ?? ''] : undefined;
      if (actor && l.timestamp && Date.parse(l.timestamp) >= cutoff) events.push({ at: l.timestamp, actor });
    }
    const cwd = header?.cwd ?? process.cwd();
    return { cwd, source: 'log', events, watermark: lines.length };
  }

  async extract(sessionId: string, o: ExtractOptions): Promise<unknown> {
    const file = this.findLog(sessionId);
    if (!file) throw new Error(`pi: лог сессии ${sessionId} не найден`);

    // pi не принимает JSON Schema флагом — схема уходит в промпт, ответ валидируется в finish
    const prompt = `${o.prompt}\n\nОтвет — только JSON-объект по этой JSON Schema, без пояснений и без markdown-ограждений:\n${JSON.stringify(o.schema)}`;
    const sessionDir = mkdtempSync(join(tmpdir(), 'chronicle-pi-fork-'));
    try {
      const cmd = ['pi', '-p', '--fork', file, '--session-dir', sessionDir, '--no-tools', '--model', o.model, prompt];
      const env = extractEnv(['PI_SESSION_ID', 'PI_SESSION_FILE']);
      const res = await this.run(cmd, { cwd: o.cwd, env, timeoutMs: EXTRACT_TIMEOUT_MS });
      if (res.code !== 0) throw new Error(`pi: код ${res.code}: ${(res.stderr || res.stdout).slice(0, 300)}`);
      return parseJsonObject(res.stdout);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }
}
