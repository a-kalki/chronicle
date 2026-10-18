/**
 * Адаптер agy (Google Antigravity CLI).
 * Лог: ~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl;
 * watermark — число обработанных полных строк.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, ExtractOptions, PathAction, SessionRead, SessionTurn } from '../finish/adapter.ts';
import { absPath, shellActions, turnText } from './paths.ts';
import { EXTRACT_TIMEOUT_MS, extractEnv, type Runner, runCommand } from './run.ts';

interface ToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface AgyLogLine {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  tool_calls?: ToolCall[];
}

function cleanArg(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function extractUserText(content: string | undefined): string | null {
  if (!content) return null;
  const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const text = match ? match[1]?.trim() : content.trim();
  return text || null;
}

const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content', 'edit_file', 'write_file']);

function toolActions(call: ToolCall, cwd: string): PathAction[] {
  const args = call.args ?? {};
  const name = call.name ?? '';

  if (name === 'run_command' || name === 'bash') {
    const cmd = cleanArg(args.CommandLine ?? args.command);
    if (!cmd) return [];
    const cmdCwd = cleanArg(args.Cwd ?? args.cwd) ?? cwd;
    return shellActions(cmd, cmdCwd);
  }

  const rawPath = cleanArg(args.TargetFile ?? args.AbsolutePath ?? args.file_path ?? args.path ?? args.target_file);
  if (!rawPath) return [];

  const isEdit = EDIT_TOOLS.has(name) || /edit|write|replace/i.test(name);
  return [{ path: absPath(rawPath, cwd), kind: isEdit ? 'edit' : 'read' }];
}

function getWorkspaceFromDb(dbPath: string, sessionId: string): string | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .query('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?')
      .get(sessionId) as { workspace_uris?: string } | null;
    db.close();
    if (!row?.workspace_uris) return null;
    const uris = JSON.parse(row.workspace_uris);
    if (Array.isArray(uris) && uris[0] && typeof uris[0] === 'string') {
      const uri = uris[0];
      return uri.startsWith('file://') ? new URL(uri).pathname : uri;
    }
  } catch {
    // игнорируем ошибку чтения SQLite
  }
  return null;
}

export class AgyAdapter implements AgentAdapter {
  readonly name = 'agy';
  readonly defaultExtractModel = 'gemini-3.8-flash-low';

  constructor(
    private readonly brainDir = join(homedir(), '.gemini/antigravity-cli/brain'),
    private readonly run: Runner = runCommand,
    private readonly dbPath = join(homedir(), '.gemini/antigravity-cli/conversation_summaries.db'),
  ) {}

  private findLog(sessionId: string): string | null {
    const logPath = join(this.brainDir, sessionId, '.system_generated/logs/transcript.jsonl');
    return existsSync(logPath) ? logPath : null;
  }

  private findCwd(lines: AgyLogLine[], sessionId: string): string {
    const fromDb = getWorkspaceFromDb(this.dbPath, sessionId);
    if (fromDb) return fromDb;

    for (let i = lines.length - 1; i >= 0; i--) {
      const calls = lines[i]?.tool_calls;
      if (!calls) continue;
      for (const call of calls) {
        const cwdArg = cleanArg(call.args?.Cwd ?? call.args?.cwd);
        if (cwdArg) return cwdArg;
      }
    }

    return process.cwd();
  }

  readSession(sessionId: string, watermark: unknown | null): SessionRead | null {
    const path = this.findLog(sessionId);
    if (!path) return null;

    // Последняя строка без перевода строки может дописываться прямо сейчас — её не берём
    const complete = readFileSync(path, 'utf8').split('\n').slice(0, -1);
    const lines = complete.map((raw) => JSON.parse(raw) as AgyLogLine);
    const from = typeof watermark === 'number' ? watermark : 0;

    const cwd = this.findCwd(lines, sessionId);
    const events: SessionRead['events'] = [];
    const turns: SessionTurn[] = [];
    /** Работа агента до первой новой реплики — достанется первому ходу */
    let pending: PathAction[] = [];

    for (const l of lines.slice(from)) {
      let actor: 'user' | 'agent' | null = null;
      if (l.source === 'USER_EXPLICIT' || l.source === 'USER') {
        actor = 'user';
      } else if (l.source === 'MODEL') {
        actor = 'agent';
      }

      if (!actor || !l.created_at) continue;
      events.push({ at: l.created_at, actor });

      if (actor === 'user') {
        const text = extractUserText(l.content);
        if (text !== null) {
          turns.push({ at: l.created_at, text: turnText(text), actions: pending });
          pending = [];
        }
      } else if (actor === 'agent' && Array.isArray(l.tool_calls)) {
        const actions = l.tool_calls.flatMap((call) => toolActions(call, cwd));
        (turns[turns.length - 1]?.actions ?? pending).push(...actions);
      }
    }

    return { cwd, source: 'log', events, turns, watermark: lines.length };
  }

  async extract(sessionId: string, o: ExtractOptions): Promise<unknown> {
    const cmd = [
      'agy',
      '--conversation',
      sessionId,
      '--model',
      o.model,
      '--effort',
      'low',
      '--disable-slash-commands',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(o.schema),
      '-p',
      o.prompt,
    ];
    // Без переменных родительской сессии
    const env = extractEnv([
      'ANTIGRAVITY_CONVERSATION_ID',
      'ANTIGRAVITY_AGENT',
      'ANTIGRAVITY_SOURCE_METADATA',
      'ANTIGRAVITY_TRAJECTORY_ID',
    ]);
    const res = await this.run(cmd, { cwd: o.cwd, env, timeoutMs: EXTRACT_TIMEOUT_MS });

    let out: { status?: string; structured_output?: unknown; response?: string; error?: string };
    try {
      out = JSON.parse(res.stdout);
    } catch {
      throw new Error(`agy: код ${res.code}, вывод не JSON: ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
    if (out.status !== 'SUCCESS' || out.structured_output === undefined) {
      throw new Error(
        `agy: ${String(out.error ?? out.response ?? (res.stderr || 'неизвестная ошибка')).slice(0, 300)}`,
      );
    }
    return out.structured_output;
  }
}
