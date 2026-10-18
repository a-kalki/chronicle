/**
 * Адаптер Claude Code. Лог: ~/.claude/projects/<каталог проекта>/<sessionId>.jsonl;
 * watermark — число обработанных полных строк.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentAdapter,
  COPIED_HISTORY_SLACK_MS,
  type ExtractOptions,
  type PathAction,
  type SessionRead,
  type SessionTurn,
} from '../finish/adapter.ts';
import { absPath, shellActions, turnText } from './paths.ts';
import { EXTRACT_TIMEOUT_MS, extractEnv, type Runner, runCommand } from './run.ts';

interface LogLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  message?: { content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

const blocks = (l: LogLine): ContentBlock[] => (Array.isArray(l.message?.content) ? l.message.content : []);

/** Текст реплики человека; служебный вывод локальных команд (/clear и т.п.) — не реплика */
function userText(l: LogLine): string | null {
  const content = l.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : blocks(l)
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join(' ');
  return text.trimStart().startsWith('<local-command-') ? null : text;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Пути вызова инструмента: правка, shell (cd, git), прочие пути — чтение и поиск */
function toolActions(b: ContentBlock, cwd: string): PathAction[] {
  const input = b.input ?? {};
  if (b.name === 'Bash') return typeof input.command === 'string' ? shellActions(input.command, cwd) : [];
  const path = [input.file_path, input.notebook_path, input.path].find((p) => typeof p === 'string');
  if (typeof path !== 'string' || !path) return [];
  return [{ path: absPath(path, cwd), kind: EDIT_TOOLS.has(b.name ?? '') ? 'edit' : 'read' }];
}

/** Результат инструмента пишется как type=user, но это работа агента */
function isToolResult(l: LogLine): boolean {
  const content = l.message?.content;
  return Array.isArray(content) && content.some((c) => (c as { type?: string })?.type === 'tool_result');
}

function actorOf(l: LogLine): 'user' | 'agent' | null {
  if (l.type === 'assistant') return 'agent';
  if (l.type === 'user' && !l.isMeta) return isToolResult(l) ? 'agent' : 'user';
  return null;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';
  readonly defaultExtractModel = 'haiku';

  constructor(
    private readonly projectsDir = join(homedir(), '.claude/projects'),
    private readonly run: Runner = runCommand,
    /** Время создания лога, мс: в форке всё, что старше, — скопированная история */
    private readonly createdAtMs: (path: string) => number = (path) => statSync(path).birthtimeMs,
  ) {}

  private findLog(sessionId: string): string | null {
    if (!existsSync(this.projectsDir)) return null;
    for (const dir of readdirSync(this.projectsDir)) {
      const path = join(this.projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(path)) return path;
    }
    return null;
  }

  readSession(sessionId: string, watermark: unknown | null): SessionRead | null {
    const path = this.findLog(sessionId);
    if (!path) return null;

    // Последняя строка без перевода строки может дописываться прямо сейчас — её не берём
    const complete = readFileSync(path, 'utf8').split('\n').slice(0, -1);
    const lines = complete.map((raw) => JSON.parse(raw) as LogLine);
    const from = typeof watermark === 'number' ? watermark : 0;

    const cutoff = this.createdAtMs(path) - COPIED_HISTORY_SLACK_MS;
    const events: SessionRead['events'] = [];
    const turns: SessionTurn[] = [];
    /** Работа агента до первой новой реплики — достанется первому ходу */
    let pending: PathAction[] = [];
    for (const l of lines.slice(from)) {
      const actor = actorOf(l);
      if (!actor || !l.timestamp || Date.parse(l.timestamp) < cutoff) continue;
      events.push({ at: l.timestamp, actor });
      const text = l.type === 'user' && actor === 'user' ? userText(l) : null;
      if (text !== null) {
        turns.push({ at: l.timestamp, text: turnText(text), actions: pending });
        pending = [];
      } else if (l.type === 'assistant') {
        const actions = blocks(l)
          .filter((b) => b.type === 'tool_use')
          .flatMap((b) => toolActions(b, l.cwd ?? process.cwd()));
        (turns[turns.length - 1]?.actions ?? pending).push(...actions);
      }
    }
    const cwd = lines.findLast((l) => l.cwd)?.cwd ?? process.cwd();
    return { cwd, source: 'log', events, turns, watermark: lines.length };
  }

  async extract(sessionId: string, o: ExtractOptions): Promise<unknown> {
    const cmd = [
      'claude',
      '-p',
      '--model',
      o.model,
      '--resume',
      sessionId,
      '--fork-session',
      '--no-session-persistence',
      '--tools',
      '',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(o.schema),
      o.prompt,
    ];
    // Без переменных родительской сессии: дочерний claude не должен считать себя вложенным
    const env = extractEnv(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT']);
    const res = await this.run(cmd, { cwd: o.cwd, env, timeoutMs: EXTRACT_TIMEOUT_MS });

    let out: { is_error?: boolean; result?: string; structured_output?: unknown };
    try {
      out = JSON.parse(res.stdout);
    } catch {
      throw new Error(`claude: код ${res.code}, вывод не JSON: ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
    if (out.is_error || out.structured_output === undefined) {
      throw new Error(`claude: ${String(out.result ?? res.stderr).slice(0, 300)}`);
    }
    return out.structured_output;
  }
}
