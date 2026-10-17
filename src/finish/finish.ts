/**
 * Общая часть /finish для всех агентов: новые события сессии → выжимка дешёвой моделью агента →
 * коммиты → отчёт сегмента по контракту → outbox. Состояние сдвигается только после постановки в очередь.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { extractResultJsonSchema } from '../../contract/json-schema.ts';
import { ExtractResult, SessionReport } from '../../contract/v1.ts';
import type { FlushResult, Outbox, SendResult } from '../cli/outbox.ts';
import { detectProject } from '../cli/project.ts';
import { activeMs } from '../domain/activity.ts';
import type { AgentAdapter } from './adapter.ts';
import { collectCommits } from './git.ts';
import type { FinishState } from './state.ts';

const EXTRACT_PROMPT = readFileSync(join(import.meta.dir, '../../prompts/extract.md'), 'utf8');

/** Сегмент короче этого и без коммитов не стоит выжимки */
const TRIVIAL_ACTIVE_MS = 60_000;
/** Порог простоя для оценки «тривиальности» (не для учёта времени — он считается на сервере) */
const TRIAGE_IDLE_MS = 30 * 60_000;

export interface FinishDeps {
  adapter: AgentAdapter;
  sessionId: string;
  host: string;
  outbox: Outbox;
  send: (report: unknown) => Promise<SendResult>;
  state: FinishState;
  extractModel?: string;
  log: (message: string) => void;
}

export type FinishResult =
  | { status: 'reported'; seq: number; flush: FlushResult }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

async function extractWithRetry(deps: FinishDeps, cwd: string): Promise<ExtractResult> {
  const { adapter, sessionId } = deps;
  const options = {
    model: deps.extractModel ?? adapter.defaultExtractModel,
    prompt: EXTRACT_PROMPT,
    schema: extractResultJsonSchema(),
    cwd,
  };
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = v.safeParse(ExtractResult, await adapter.extract(sessionId, options));
      if (parsed.success) return parsed.output;
      lastError = parsed.issues.map((i) => `${v.getDotPath(i)}: ${i.message}`).join('; ');
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    deps.log(`выжимка, попытка ${attempt}: ${lastError}`);
  }
  throw new Error(`выжимка не получена: ${lastError}`);
}

export async function runFinish(deps: FinishDeps): Promise<FinishResult> {
  const { adapter, sessionId, state } = deps;
  const release = state.lock(adapter.name, sessionId);
  if (!release) return { status: 'skipped', reason: 'finish этой сессии уже идёт' };

  try {
    const prev = state.load(adapter.name, sessionId);
    const read = adapter.readSession(sessionId, prev?.watermark ?? null);
    if (!read) return { status: 'skipped', reason: 'лог сессии не найден' };

    let startedAt: string;
    let endedAt: string;
    if (read.source === 'log') {
      if (read.events.length < 2 || !read.events.some((e) => e.actor === 'user')) {
        return { status: 'skipped', reason: 'нет новой активности' };
      }
      const times = read.events.map((e) => e.at).sort();
      startedAt = times[0] as string;
      endedAt = times[times.length - 1] as string;
    } else {
      if (!read.startedAt || !read.endedAt) return { status: 'failed', reason: 'coarse без интервала' };
      startedAt = read.startedAt;
      endedAt = read.endedAt;
    }

    const project = detectProject(read.cwd);
    const { commits, files } = collectCommits(project.path, startedAt, endedAt);
    const span = { startedAt, endedAt, source: read.source, events: read.events };
    if (activeMs(span, TRIAGE_IDLE_MS) < TRIVIAL_ACTIVE_MS && commits.length === 0) {
      return { status: 'skipped', reason: 'тривиальный сегмент' };
    }

    const extract = await extractWithRetry(deps, read.cwd);
    const seq = (prev?.seq ?? 0) + 1;
    const report = v.parse(SessionReport, {
      version: 1,
      session: { agent: adapter.name, id: sessionId, host: deps.host, seq, startedAt, endedAt },
      project,
      activity: { source: read.source, events: read.events },
      work: { ...extract.work, commits, files },
      knowledge: extract.knowledge,
      usage: extract.usage,
    });

    deps.outbox.enqueue(report);
    state.save(adapter.name, sessionId, { seq, watermark: read.watermark });
    return { status: 'reported', seq, flush: await deps.outbox.flush(deps.send) };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : String(e) };
  } finally {
    release();
  }
}
