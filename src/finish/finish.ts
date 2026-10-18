/**
 * Общая часть /finish и replay для всех агентов: новые события и ходы сессии → проекты ходов по путям →
 * коммиты всех затронутых репо → выжимка дешёвой моделью агента → отчёт сегмента v2 → outbox.
 * Состояние сдвигается только после постановки в очередь.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { extractResultJsonSchema } from '../../contract/json-schema.ts';
import { ExtractResult, SessionReport } from '../../contract/v2.ts';
import type { FlushResult, Outbox, SendResult } from '../cli/outbox.ts';
import { type DetectedProject, repoResolver } from '../cli/project.ts';
import { activeMs } from '../domain/activity.ts';
import { turnFocuses } from '../domain/episodes.ts';
import { mainProject, turnProjects } from '../domain/turn-project.ts';
import type { AgentAdapter, SessionTurn } from './adapter.ts';
import { type CollectedCommits, collectCommits } from './git.ts';
import type { FinishState } from './state.ts';

const EXTRACT_PROMPT = readFileSync(join(import.meta.dir, '../../prompts/extract.md'), 'utf8');

/** Сегмент короче этого и без коммитов не стоит выжимки */
const TRIVIAL_ACTIVE_MS = 60_000;
/** Порог простоя для оценки «тривиальности» (не для учёта времени — он считается на сервере) */
const TRIAGE_IDLE_MS = 30 * 60_000;
/** Сколько итогов прошлых сегментов держать для выжимки продолжения */
const SUMMARIES_KEPT = 10;

const hhmm = (at: string) =>
  new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });

interface PromptInput {
  turns: { idx: number; at: string; text: string }[];
  /** Недавние фокусы по имени проекта */
  focuses: Record<string, string[]>;
  summaries: string[];
  startedAt: string;
  replay: boolean;
}

/** Промпт выжимки: общий + список ходов, недавние фокусы, продолжение сессии, пересборка */
function extractPrompt(p: PromptInput): string {
  const parts = [EXTRACT_PROMPT];
  const turns = p.turns.map((t) => `#${t.idx} ${hhmm(t.at)} «${t.text}»`).join('\n');
  parts.push(`## Ходы этой части сессии\n\n${turns || '(реплик нет)'}`);
  const focuses = Object.entries(p.focuses).filter(([, f]) => f.length > 0);
  if (focuses.length > 0) {
    const list = focuses.map(([name, f]) => `- ${name}: ${f.map((x) => `«${x}»`).join(', ')}`).join('\n');
    parts.push(`## Недавние фокусы затронутых проектов\n\n${list}`);
  }
  if (p.summaries.length > 0) {
    parts.push(`## Это продолжение сессии

Прошлые части этой сессии уже отправлены. Опиши только то, что сделано после них (новая часть началась около ${hhmm(p.startedAt)}, ход #${p.turns[0]?.idx ?? 1}): не повторяй уже отправленные итоги и знания.

Уже отправлено:
${p.summaries.map((s) => `- ${s}`).join('\n')}`);
  }
  if (p.replay) {
    parts.push(
      '## Пересборка\n\nЭто повторная разметка всей сессии: верни `knowledge: []` и `usage: []`, нужен только `work`.',
    );
  }
  return `${parts.join('\n\n')}\n`;
}

export interface FinishDeps {
  adapter: AgentAdapter;
  sessionId: string;
  host: string;
  outbox: Outbox;
  send: (report: unknown) => Promise<SendResult>;
  state: FinishState;
  extractModel?: string;
  log: (message: string) => void;
  /** Пересборка сессии целиком (chronicle replay): лог с начала, без знаний, replace */
  replay?: boolean;
  /** Репозиторий пути; null — вне git. По умолчанию — git с запоминанием по каталогу */
  findRepo?: (path: string) => DetectedProject | null;
  collectCommits?: (repo: string, from: string, to: string) => CollectedCommits;
}

export type FinishResult =
  | { status: 'reported'; seq: number; summary: string; knowledge: number; flush: FlushResult }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

async function extractWithRetry(
  deps: FinishDeps,
  cwd: string,
  prompt: string,
  watermark: unknown | null,
): Promise<ExtractResult> {
  const { adapter, sessionId } = deps;
  const options = {
    model: deps.extractModel ?? adapter.defaultExtractModel,
    prompt,
    schema: extractResultJsonSchema(),
    cwd,
    watermark,
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

/** Проекты сегмента: ключ отчёта (p1, p2, …) по корню репо; проект ходов — по весам путей */
function resolveProjects(cwd: string, turns: SessionTurn[], resolve: (path: string) => DetectedProject | null) {
  const repos = new Map<string, DetectedProject & { key: string }>();
  const keyOf = (repo: DetectedProject | null): string | null => {
    if (!repo) return null;
    if (!repos.has(repo.path)) repos.set(repo.path, { ...repo, key: `p${repos.size + 1}` });
    return repos.get(repo.path)?.key ?? null;
  };
  const launchKey = keyOf(resolve(cwd));
  const projectKeys = turnProjects(
    turns.map((t) => ({ actions: t.actions.map((a) => ({ project: keyOf(resolve(a.path)), kind: a.kind })) })),
    launchKey,
  );
  // в отчёт — только проекты запуска и ходов: репо, где лишь читали, на проект хода не повлияли
  const used = new Set([launchKey, ...projectKeys]);
  const projects = [...repos.values()].filter((r) => used.has(r.key));
  return { launchKey, projectKeys, projects };
}

export async function runFinish(deps: FinishDeps): Promise<FinishResult> {
  const { adapter, sessionId, state, replay = false } = deps;
  const release = state.lock(adapter.name, sessionId);
  if (!release) return { status: 'skipped', reason: 'finish этой сессии уже идёт' };

  try {
    const prev = state.load(adapter.name, sessionId);
    const watermark = replay ? null : (prev?.watermark ?? null);
    const read = adapter.readSession(sessionId, watermark);
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

    const { launchKey, projectKeys, projects } = resolveProjects(read.cwd, read.turns, deps.findRepo ?? repoResolver());
    const collect = deps.collectCommits ?? collectCommits;
    const commits: SessionReport['work']['commits'] = [];
    const files: SessionReport['work']['files'] = [];
    for (const p of projects) {
      const found = collect(p.path, startedAt, endedAt);
      commits.push(...found.commits.map((c) => ({ ...c, projectKey: p.key })));
      files.push(...found.files.map((path) => ({ projectKey: p.key, path })));
    }

    const span = { startedAt, endedAt, source: read.source, events: read.events };
    if (!replay && activeMs(span, TRIAGE_IDLE_MS) < TRIVIAL_ACTIVE_MS && commits.length === 0) {
      return { status: 'skipped', reason: 'тривиальный сегмент' };
    }

    const firstIdx = (replay ? 0 : (prev?.turns ?? 0)) + 1;
    const turns = read.turns.map((t, i) => ({ ...t, idx: firstIdx + i, projectKey: projectKeys[i] ?? null }));
    const focusKey = (p: DetectedProject) => p.remote ?? p.path;
    const summaries = replay ? [] : (prev?.summaries ?? []);
    const prompt = extractPrompt({
      turns,
      focuses: Object.fromEntries(projects.map((p) => [p.name, state.recentFocuses(focusKey(p))])),
      summaries,
      startedAt,
      replay,
    });
    const extract = await extractWithRetry(deps, read.cwd, prompt, watermark);

    const { episodes } = extract.work;
    const focuses = turnFocuses(
      turns.map((t) => t.idx),
      episodes,
    );
    const outcomes = episodes.flatMap((e) => {
      const lo = Math.min(e.from, e.to);
      const hi = Math.max(e.from, e.to);
      const projectKey = mainProject(
        turns.filter((t) => t.idx >= lo && t.idx <= hi).map((t) => t.projectKey),
        launchKey,
      );
      return e.items.map((text) => ({ projectKey, focus: e.focus, text }));
    });
    const seq = (prev?.seq ?? 0) + 1;
    const report = v.parse(SessionReport, {
      version: 2,
      ...(replay ? { replace: true } : {}),
      session: { agent: adapter.name, id: sessionId, host: deps.host, seq, startedAt, endedAt },
      launch: { cwd: read.cwd, projectKey: launchKey },
      projects: projects.map(({ key, name, path, remote }) =>
        remote ? { key, remote, name, path } : { key, name, path },
      ),
      activity: { source: read.source, events: read.events },
      turns: turns.map((t, i) => ({ idx: t.idx, at: t.at, projectKey: t.projectKey, focus: focuses[i] ?? null })),
      work: { summary: extract.work.summary, outcomes, commits, files },
      knowledge: replay ? [] : extract.knowledge,
      usage: replay ? [] : extract.usage,
    });

    deps.outbox.enqueue(report);
    const items = outcomes.map((o) => o.text).join('; ');
    const summary = [extract.work.summary, items].filter(Boolean).join(': ');
    state.save(adapter.name, sessionId, {
      seq,
      watermark: read.watermark,
      summaries: [...summaries, summary].slice(-SUMMARIES_KEPT),
      turns: firstIdx - 1 + turns.length,
    });
    state.rememberFocuses(
      Object.fromEntries(
        projects.map((p) => [
          focusKey(p),
          turns.flatMap((t, i) => (t.projectKey === p.key && focuses[i] ? [focuses[i]] : [])),
        ]),
      ),
    );
    return {
      status: 'reported',
      seq,
      summary: extract.work.summary,
      knowledge: report.knowledge.length,
      flush: await deps.outbox.flush(deps.send),
    };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : String(e) };
  } finally {
    release();
  }
}
