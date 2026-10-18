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
  type PathAction,
  type SessionRead,
  type SessionTurn,
} from '../finish/adapter.ts';
import { parseModelJson } from './model-json.ts';
import { absPath, shellActions, turnText } from './paths.ts';
import { abandonedBranchesText, collapseSkills, type PiLine, textOf } from './pi-branches.ts';
import { EXTRACT_TIMEOUT_MS, extractEnv, type Runner, runCommand } from './run.ts';

interface LogLine extends PiLine {
  cwd?: string;
}

const ACTORS: Record<string, 'user' | 'agent'> = { user: 'user', assistant: 'agent', toolResult: 'agent' };

const EDIT_TOOLS = new Set(['edit', 'write']);

/** Пути вызова инструмента: правка, shell (cd, git), прочие пути — чтение и поиск */
function callActions(c: { name?: string; arguments?: Record<string, unknown> }, cwd: string): PathAction[] {
  const args = c.arguments ?? {};
  if (c.name === 'bash') return typeof args.command === 'string' ? shellActions(args.command, cwd) : [];
  if (typeof args.path !== 'string' || !args.path) return [];
  return [{ path: absPath(args.path, cwd), kind: EDIT_TOOLS.has(c.name ?? '') ? 'edit' : 'read' }];
}

/** Полные строки лога: последняя без перевода строки может дописываться прямо сейчас — её не берём */
function readLines(path: string): LogLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .slice(0, -1)
    .map((raw) => JSON.parse(raw) as LogLine);
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

    const lines = readLines(path);
    const from = typeof watermark === 'number' ? watermark : 0;

    // Заголовок сессии — момент её создания: в форке всё, что старше, — скопированная история
    const header = lines.find((l) => l.type === 'session');
    const cutoff = header?.timestamp ? Date.parse(header.timestamp) - COPIED_HISTORY_SLACK_MS : 0;
    const cwd = header?.cwd ?? process.cwd();
    const events: SessionRead['events'] = [];
    const turns: SessionTurn[] = [];
    /** Работа агента до первой новой реплики — достанется первому ходу */
    let pending: PathAction[] = [];
    for (const l of lines.slice(from)) {
      const role = l.message?.role ?? '';
      const actor = l.type === 'message' ? ACTORS[role] : undefined;
      if (!actor || !l.timestamp || Date.parse(l.timestamp) < cutoff) continue;
      events.push({ at: l.timestamp, actor });
      if (role === 'user') {
        turns.push({ at: l.timestamp, text: turnText(collapseSkills(textOf(l.message?.content))), actions: pending });
        pending = [];
      } else if (role === 'assistant' && Array.isArray(l.message?.content)) {
        const actions = (l.message.content as { type?: string; name?: string; arguments?: Record<string, unknown> }[])
          .filter((c) => c?.type === 'toolCall')
          .flatMap((c) => callActions(c, cwd));
        (turns[turns.length - 1]?.actions ?? pending).push(...actions);
      }
    }
    return { cwd, source: 'log', events, turns, watermark: lines.length };
  }

  async extract(sessionId: string, o: ExtractOptions): Promise<unknown> {
    const file = this.findLog(sessionId);
    if (!file) throw new Error(`pi: лог сессии ${sessionId} не найден`);

    // Форк видит только активную ветку — брошенные через /tree без сводки добавляем текстом
    const branches = abandonedBranchesText(readLines(file), typeof o.watermark === 'number' ? o.watermark : 0);
    const branchesSection = branches
      ? `\n\n## Брошенные ветки сессии\n\nКроме текущей ветки, в этой части сессии были ответвления (возврат назад через /tree); их нет в контексте выше — ниже их сжатый протокол. Часто каждое ответвление — отдельная задача. Выжимка описывает ВСЮ эту часть сессии: summary — общий итог, в items — по пункту на каждое ответвление, где что-то сделано (лимит 2–7 пунктов здесь не действует), ошибки из ответвлений — кандидаты в ловушки.\n\n${branches}`
      : '';
    // pi не принимает JSON Schema флагом — схема уходит в промпт, ответ валидируется в finish
    const prompt = `${o.prompt}${branchesSection}\n\nОтвет — только JSON-объект по этой JSON Schema, без пояснений и без markdown-ограждений:\n${JSON.stringify(o.schema)}`;
    const sessionDir = mkdtempSync(join(tmpdir(), 'chronicle-pi-fork-'));
    try {
      const cmd = ['pi', '-p', '--fork', file, '--session-dir', sessionDir, '--no-tools', '--model', o.model, prompt];
      const env = extractEnv(['PI_SESSION_ID', 'PI_SESSION_FILE']);
      const res = await this.run(cmd, { cwd: o.cwd, env, timeoutMs: EXTRACT_TIMEOUT_MS });
      if (res.code !== 0) throw new Error(`pi: код ${res.code}: ${(res.stderr || res.stdout).slice(0, 300)}`);
      return parseModelJson(res.stdout);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }
}
