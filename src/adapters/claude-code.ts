/**
 * Адаптер Claude Code. Лог: ~/.claude/projects/<каталог проекта>/<sessionId>.jsonl;
 * watermark — число обработанных полных строк.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, ExtractOptions, SessionRead } from '../finish/adapter.ts';
import { EXTRACT_TIMEOUT_MS, extractEnv, type Runner, runCommand } from './run.ts';

interface LogLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  message?: { content?: unknown };
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

    const events: SessionRead['events'] = [];
    for (const l of lines.slice(from)) {
      const actor = actorOf(l);
      if (actor && l.timestamp) events.push({ at: l.timestamp, actor });
    }
    const cwd = lines.findLast((l) => l.cwd)?.cwd ?? process.cwd();
    return { cwd, source: 'log', events, watermark: lines.length };
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
