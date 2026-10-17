#!/usr/bin/env bun
/**
 * Разовый импорт из pi-chronicle (docs/plan.md, этап 4).
 *
 *   bun scripts/import-pi-chronicle.ts prepare   # → import/review.json + import/review.md, ничего не отправляет
 *   bun scripts/import-pi-chronicle.ts apply     # после просмотра: записи знаний + отчёты worklog + состояние pi
 *
 * Знания: LLM (DeepSeek) отбирает ловушки и факты и приводит запись к полям «симптомы — причина — решение»;
 * решение `keep` в review.json можно поправить руками перед apply. Записи идут мимо курирования, с исходными ID.
 * Worklog: каждая запись → отчёт сегмента 1 сессии pi (coarse: интервал = начало + активные минуты).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import * as v from 'valibot';
import { KnowledgeCandidate, SessionReport } from '../contract/v1.ts';
import { ApiClient } from '../src/cli/api.ts';
import { loadClientConfig } from '../src/cli/config.ts';
import { Outbox } from '../src/cli/outbox.ts';
import { detectProject } from '../src/cli/project.ts';
import { similarity, stems } from '../src/domain/similarity.ts';
import { FinishState } from '../src/finish/state.ts';
import { createLlm } from '../src/infra/openai-llm.ts';

const PI_CHRONICLE = join(homedir(), 'dev/tools/pi-chronicle/data');
const OUT = join(import.meta.dir, '../import');
const HOST = 'laptop';

const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

// ── Знания ────────────────────────────────────────────────────────────────

interface OldEntry {
  kind: string;
  tags: string[];
  description: string;
  file: string;
  opened?: number;
  helped?: number;
}

interface SourceEntry {
  id: string;
  store: string;
  /** Для проектного реестра — путь проекта */
  projectPath: string | null;
  meta: OldEntry;
  body: string;
}

function knowledgeSources(): SourceEntry[] {
  const stores = [{ store: 'global', dir: join(PI_CHRONICLE, 'knowledge'), projectPath: null as string | null }];
  const projects = readJson<{ projects: Record<string, { path: string; knowledge_dir: string }> }>(
    join(PI_CHRONICLE, 'knowledge/projects.json'),
  ).projects;
  for (const [name, p] of Object.entries(projects)) {
    stores.push({ store: name, dir: join(expand(p.path), p.knowledge_dir), projectPath: expand(p.path) });
  }

  const out: SourceEntry[] = [];
  for (const s of stores) {
    if (!existsSync(join(s.dir, 'registry.json'))) continue;
    const reg = readJson<{ entries: Record<string, OldEntry> }>(join(s.dir, 'registry.json'));
    for (const [id, meta] of Object.entries(reg.entries)) {
      out.push({
        id,
        store: s.store,
        projectPath: s.projectPath,
        meta,
        body: readFileSync(join(s.dir, 'entries', meta.file), 'utf8'),
      });
    }
  }
  return out;
}

const CLASSIFY_PROMPT = `Ты переносишь запись старой базы знаний агентов-программистов в новую. Новая база хранит только:
- trap — ловушка: конкретный симптом (дословный текст ошибки или странное поведение) → причина → решение;
- fact — неочевидный факт окружения, который нельзя вывести из кода и документации (пути, серверы, ограничения инструментов).

Практики, принципы, архитектурные решения, договорённости проекта и общеизвестное — НЕ переносятся (keep: false): им место в документации проекта.

Если keep: true — приведи запись к полям: title (короткое утверждение о сути), symptoms (дословные тексты ошибок из записи, не перефразируя; если их нет — пустой массив), cause, fix (конкретно, с командами и путями из записи), tags. scope: "project" — только если знание относится к этому проекту; про инструменты, языки, окружение, агентов — "global". Убери из текста служебный мусор (строки «Если помогло…», повторы).

Ответь JSON-объектом: { "keep": boolean, "reason": "почему", "entry": { "scope", "kind", "title", "symptoms", "cause", "fix", "tags" } } (entry — только при keep: true). Язык — русский; ошибки, команды, идентификаторы — как есть.`;

const Classified = v.variant('keep', [
  v.object({ keep: v.literal(true), reason: v.string(), entry: KnowledgeCandidate }),
  v.object({ keep: v.literal(false), reason: v.string() }),
]);

interface ReviewEntry {
  sourceId: string;
  store: string;
  oldKind: string;
  oldTitle: string;
  /** Можно поправить руками перед apply */
  keep: boolean;
  reason: string;
  projectPath: string | null;
  stats: { opened: number; helped: number };
  entry?: KnowledgeCandidate;
}

async function classifyAll(sources: SourceEntry[]): Promise<ReviewEntry[]> {
  const llm = createLlm({ model: 'deepseek/deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' }, process.env);
  const results: ReviewEntry[] = [];
  const queue = [...sources];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const user = JSON.stringify({
        project: s.store === 'global' ? null : s.store,
        kind: s.meta.kind,
        tags: s.meta.tags,
        body: s.body,
      });
      let parsed: v.SafeParseResult<typeof Classified> | null = null;
      for (let attempt = 0; attempt < 2 && !parsed?.success; attempt++) {
        parsed = v.safeParse(Classified, await llm.completeJson(CLASSIFY_PROMPT, user));
      }
      const base = {
        sourceId: s.id,
        store: s.store,
        oldKind: s.meta.kind,
        oldTitle: s.meta.description,
        projectPath: s.projectPath,
        stats: { opened: s.meta.opened ?? 0, helped: s.meta.helped ?? 0 },
      };
      if (!parsed?.success) {
        results.push({ ...base, keep: false, reason: 'LLM не дала ответ по схеме — проверить вручную' });
      } else if (parsed.output.keep) {
        results.push({ ...base, keep: true, reason: parsed.output.reason, entry: parsed.output.entry });
      } else {
        results.push({ ...base, keep: false, reason: parsed.output.reason });
      }
      console.log(
        `  ${results.length}/${sources.length} ${s.id}: ${results.at(-1)?.keep ? 'перенести' : 'не переносить'}`,
      );
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return results.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

/** Вероятные дубли среди переносимых: пара ID и схожесть */
function duplicates(review: ReviewEntry[]): [string, string, number][] {
  const kept = review.filter((r) => r.keep && r.entry);
  const text = (r: ReviewEntry) => stems(`${r.entry?.title} ${r.entry?.symptoms.join(' ')} ${r.entry?.tags.join(' ')}`);
  const pairs: [string, string, number][] = [];
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const score = similarity(text(kept[i] as ReviewEntry), text(kept[j] as ReviewEntry));
      if (score >= 0.5) pairs.push([(kept[i] as ReviewEntry).sourceId, (kept[j] as ReviewEntry).sourceId, score]);
    }
  }
  return pairs;
}

// ── Worklog ───────────────────────────────────────────────────────────────

interface WorklogEntry {
  session_id: string;
  started_at: string;
  /** Настоящий конец сессии — для watermark (в отчёте конец сдвинут) */
  ended_at: string;
  duration_minutes: number;
  cwd: string;
  summary: string;
  details: string[];
  commits: { hash: string; date: string; subject: string }[];
  changed_files: string[];
}

function worklogEntries(): WorklogEntry[] {
  const dir = join(PI_CHRONICLE, 'worklog/months');
  return Array.from(new Bun.Glob('*.json').scanSync(dir))
    .flatMap((f) => Object.values(readJson<{ entries: Record<string, WorklogEntry> }>(join(dir, f)).entries))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** «10-01 10:59» (локальное время pi-chronicle) → ISO с годом начала сессии */
function commitTime(date: string, startedAt: string): string {
  const [md = '', hm = ''] = date.split(' ');
  return new Date(`${startedAt.slice(0, 4)}-${md}T${hm}:00`).toISOString();
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function worklogReport(w: WorklogEntry): unknown {
  const project = existsSync(w.cwd) ? detectProject(w.cwd) : { name: basename(w.cwd) || 'home', path: w.cwd };
  const files = [
    ...new Set(
      w.changed_files.map((f) => (isAbsolute(f) && f.startsWith(`${project.path}/`) ? relative(project.path, f) : f)),
    ),
  ];
  // coarse: интервал = начало + активные минуты, чтобы учёт времени совпал с pi-chronicle
  const endedAt = new Date(Date.parse(w.started_at) + w.duration_minutes * 60_000).toISOString();
  return {
    version: 1,
    session: { agent: 'pi', id: w.session_id, host: HOST, seq: 1, startedAt: w.started_at, endedAt },
    project,
    activity: { source: 'coarse', events: [] },
    work: {
      summary: clip(w.summary.trim() || 'Без итога', 500),
      items: w.details
        .filter((d) => d.trim())
        .map((d) => clip(d, 500))
        .slice(0, 50),
      commits: w.commits.map((c) => ({
        hash: c.hash,
        subject: clip(c.subject, 500),
        at: commitTime(c.date, w.started_at),
      })),
      files,
    },
    knowledge: [],
    usage: [],
  };
}

/** Число полных строк лога pi, записанных до конца сегмента — watermark для адаптера */
function piWatermark(sessionId: string, endedAt: string): number | null {
  const sessionsDir = join(homedir(), '.pi/agent/sessions');
  const file = new Bun.Glob(`*/*_${sessionId}.jsonl`).scanSync(sessionsDir).next().value;
  if (!file) return null;
  const lines = readFileSync(join(sessionsDir, file), 'utf8').split('\n').slice(0, -1);
  let n = 0;
  for (const [i, raw] of lines.entries()) {
    const ts = (JSON.parse(raw) as { timestamp?: string }).timestamp;
    if (ts && ts > endedAt) break;
    n = i + 1;
  }
  return n;
}

// ── Команды ───────────────────────────────────────────────────────────────

async function prepare() {
  mkdirSync(OUT, { recursive: true });
  const sources = knowledgeSources();
  console.log(`Знания: ${sources.length} записей, классификация…`);
  const knowledge = await classifyAll(sources);

  const worklog = worklogEntries().map((w) => {
    const report = worklogReport(w);
    const check = v.safeParse(SessionReport, report);
    const issues = check.success ? [] : check.issues.map((i) => `${v.getDotPath(i)}: ${i.message}`);
    return { report, endedAt: w.ended_at, issues };
  });

  const review = { knowledge, duplicates: duplicates(knowledge), worklog };
  await Bun.write(join(OUT, 'review.json'), JSON.stringify(review, null, 2));
  await Bun.write(join(OUT, 'review.md'), reviewMarkdown(review));
  console.log(`Готово: ${join(OUT, 'review.md')} (решения — review.json, поле keep)`);
}

function reviewMarkdown(r: {
  knowledge: ReviewEntry[];
  duplicates: [string, string, number][];
  worklog: { report: unknown; issues: string[] }[];
}): string {
  const kept = r.knowledge.filter((k) => k.keep);
  const dropped = r.knowledge.filter((k) => !k.keep);
  const scope = (k: ReviewEntry) => (k.entry?.scope === 'project' ? k.store : 'global');
  const lines = [
    '# Импорт из pi-chronicle — на просмотр',
    '',
    `Знаний: ${r.knowledge.length}; перенести: ${kept.length}; не переносить: ${dropped.length}.`,
    'Поправить решение — поле `keep` в `review.json`, затем `apply`.',
    '',
    `## Перенести (${kept.length})`,
    '',
    ...kept.map((k) => `- **${k.sourceId}** (${k.entry?.kind}, ${scope(k)}) ${k.entry?.title}`),
    '',
    `## Не переносить (${dropped.length})`,
    '',
    ...dropped.map((k) => `- **${k.sourceId}** (было: ${k.oldKind}) ${k.oldTitle}\n  — ${k.reason}`),
    '',
    `## Вероятные дубли среди переносимых (${r.duplicates.length})`,
    '',
    ...r.duplicates.map(([a, b, s]) => `- ${a} ↔ ${b} (≈${s.toFixed(2)})`),
    '',
    `## Worklog: ${r.worklog.length} сессий`,
    '',
    'Интервал сегмента = начало + активные минуты pi-chronicle (конец сдвинут, учёт времени совпадает).',
    '',
    ...r.worklog.filter((w) => w.issues.length).map((w) => `- ⚠ ${JSON.stringify(w.issues)}`),
  ];
  return `${lines.join('\n')}\n`;
}

async function apply() {
  const review = readJson<{
    knowledge: ReviewEntry[];
    worklog: { report: SessionReport; endedAt: string; issues: string[] }[];
  }>(join(OUT, 'review.json'));
  const config = loadClientConfig(process.env);
  const api = new ApiClient(config.serverUrl, config.token);

  const entries = review.knowledge
    .filter((k) => k.keep && k.entry)
    .map((k) => {
      const { scope, ...fields } = k.entry as KnowledgeCandidate;
      const project = scope === 'project' && k.projectPath ? { ...detectProject(k.projectPath), host: HOST } : null;
      return { id: k.sourceId, project, ...fields, note: `pi-chronicle (${k.store}): ${k.oldKind}`, stats: k.stats };
    });
  const imported = await api.importEntries(entries);
  console.log(`Знания: импортировано ${imported.imported.length}, уже были ${imported.skipped.length}`);

  const outbox = new Outbox(config.outboxDir);
  const state = new FinishState(join(config.stateDir, 'sessions'));
  let watermarks = 0;
  for (const { report, endedAt, issues } of review.worklog) {
    if (issues.length) continue;
    outbox.enqueue(report);
    const wm = piWatermark(report.session.id, endedAt);
    if (wm !== null && !state.load('pi', report.session.id)) {
      state.save('pi', report.session.id, { seq: 1, watermark: wm });
      watermarks++;
    }
  }
  const flush = await outbox.flush((r) => api.sendReport(r));
  console.log(`Worklog: ${JSON.stringify(flush)}; состояние pi сохранено для ${watermarks} сессий`);
}

const cmd = process.argv[2];
if (cmd === 'prepare') await prepare();
else if (cmd === 'apply') await apply();
else console.log('bun scripts/import-pi-chronicle.ts prepare|apply');
