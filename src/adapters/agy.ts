/**
 * Адаптер agy (Google Antigravity CLI). Корень данных — ~/.gemini/antigravity-cli:
 * лог brain/<sessionId>/.system_generated/logs/transcript.jsonl, диалог conversations/<sessionId>.db (SQLite);
 * watermark — число обработанных полных строк лога.
 * Выжимка: форка у agy нет — выжимается копия диалога под новым id, затем её следы убираются.
 */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Начало общего промпта выжимки (prompts/extract.md). Раньше выжимка шла прямо в рабочем диалоге —
 * такие реплики и ответ на них не работа сессии.
 */
export const EXTRACT_PROMPT_HEAD = 'Сессия завершается. Сделай выжимку этой сессии для сервиса chronicle';

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

const AGY_ROOT = join(homedir(), '.gemini/antigravity-cli');

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

/** Сколько начала лога смотреть: первая реплика человека — в первых строках */
const HEAD_BYTES = 64 * 1024;

/**
 * Диалог человека — в логе есть его реплика. У субагента её нет (начинается с SYSTEM),
 * а строка в conversation_summaries.db с родителем появляется позже первых хуков.
 */
export function isAgyUserConversation(conversationId: string, root = AGY_ROOT): boolean {
  const path = join(root, 'brain', conversationId, '.system_generated/logs/transcript.jsonl');
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).includes('"source":"USER_EXPLICIT"');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Копия диалога под новым id: снимок базы (безопасно при записи agy) и замена id внутри */
function copyConversation(src: string, dest: string, fromId: string, toId: string): void {
  const from = new Database(src, { readonly: true });
  try {
    from.run('VACUUM INTO ?', [dest]);
  } finally {
    from.close();
  }
  const db = new Database(dest);
  try {
    db.run('UPDATE trajectory_meta SET cascade_id = ?', [toId]);
    const rows = db.query('SELECT id, data FROM trajectory_metadata_blob').all() as { id: string; data: Uint8Array }[];
    const a = Buffer.from(fromId);
    const b = Buffer.from(toId);
    for (const row of rows) {
      const data = Buffer.from(row.data);
      for (let i = data.indexOf(a); i >= 0; i = data.indexOf(a, i + b.length)) b.copy(data, i);
      db.run('UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?', [data, row.id]);
    }
  } finally {
    db.close();
  }
}

function readJson(path: string): Record<string, string> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    return null;
  }
}

export class AgyAdapter implements AgentAdapter {
  readonly name = 'agy';
  readonly defaultExtractModel = 'gemini-3.8-flash-low';

  constructor(
    private readonly root = AGY_ROOT,
    private readonly run: Runner = runCommand,
    private readonly newId: () => string = randomUUID,
  ) {}

  private get summariesDb(): string {
    return join(this.root, 'conversation_summaries.db');
  }

  private findLog(sessionId: string): string | null {
    const logPath = join(this.root, 'brain', sessionId, '.system_generated/logs/transcript.jsonl');
    return existsSync(logPath) ? logPath : null;
  }

  private findCwd(lines: AgyLogLine[], sessionId: string): string {
    const fromDb = getWorkspaceFromDb(this.summariesDb, sessionId);
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
    /** Идёт старая выжимка в рабочем диалоге — до следующей реплики человека */
    let extracting = false;

    for (const l of lines.slice(from)) {
      let actor: 'user' | 'agent' | null = null;
      if (l.source === 'USER_EXPLICIT' || l.source === 'USER') {
        actor = 'user';
      } else if (l.source === 'MODEL') {
        actor = 'agent';
      }

      if (!actor || !l.created_at) continue;
      const text = actor === 'user' ? extractUserText(l.content) : null;
      if (actor === 'user') extracting = text?.startsWith(EXTRACT_PROMPT_HEAD) ?? false;
      if (extracting) continue;
      events.push({ at: l.created_at, actor });

      if (actor === 'user') {
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
    const src = join(this.root, 'conversations', `${sessionId}.db`);
    if (!existsSync(src)) throw new Error(`agy: диалог ${sessionId} не найден`);

    const copyId = this.newId();
    const lastPath = join(this.root, 'cache/last_conversations.json');
    const lastBefore = readJson(lastPath);
    copyConversation(src, join(this.root, 'conversations', `${copyId}.db`), sessionId, copyId);
    try {
      return await this.extractCopy(copyId, o);
    } finally {
      this.removeCopy(copyId, lastPath, lastBefore);
    }
  }

  private async extractCopy(copyId: string, o: ExtractOptions): Promise<unknown> {
    const cmd = [
      'agy',
      '--conversation',
      copyId,
      '--model',
      o.model,
      '--effort',
      'low',
      '--disable-slash-commands',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(o.schema),
      // -p забирает следующий аргумент как промпт — только в конце
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

  /** Следы копии: файлы диалога, строка в списке диалогов (/resume), «последний диалог» workspace (agy -c) */
  private removeCopy(copyId: string, lastPath: string, lastBefore: Record<string, string> | null): void {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(join(this.root, 'conversations', `${copyId}.db${suffix}`), { force: true });
    }
    rmSync(join(this.root, 'brain', copyId), { recursive: true, force: true });
    rmSync(join(this.root, 'annotations', `${copyId}.pbtxt`), { force: true });
    try {
      const db = new Database(this.summariesDb);
      db.run('DELETE FROM conversation_summaries WHERE conversation_id = ?', [copyId]);
      db.close();
    } catch {
      // списка диалогов нет — убирать нечего
    }
    const last = readJson(lastPath);
    if (!last) return;
    let changed = false;
    for (const [workspace, id] of Object.entries(last)) {
      if (id !== copyId) continue;
      const before = lastBefore?.[workspace];
      if (before) last[workspace] = before;
      else delete last[workspace];
      changed = true;
    }
    if (changed) writeFileSync(lastPath, JSON.stringify(last, null, 2));
  }
}
