/**
 * Контракт v2 — модель работы v2 (docs/agent-contract.md): проект и фокус — у хода, а не у сессии.
 *
 * ExtractResult — выжимка агента: итог и эпизоды по номерам ходов (фокус + результаты).
 * SessionReport — отчёт сегмента: проекты, ходы, результаты, коммиты и файлы с проектом.
 * Проекты ходов, коммиты, файлы и активность собирает адаптер — агенту их не доверяем.
 */
import * as v from 'valibot';
import { Activity, envelopeIssues, Knowledge, reportCheck, Session, Text, Timestamp, Usage } from './common.ts';

export { KnowledgeCandidate } from './common.ts';

const TurnNo = v.pipe(v.number(), v.integer(), v.minValue(1));
const Focus = Text(60);

export const Episode = v.object({
  /** Диапазон номеров ходов из списка в промпте, включительно */
  from: TurnNo,
  to: TurnNo,
  /** Короткая метка части работы; переиспользовать недавний фокус, если подходит */
  focus: Focus,
  /** Результаты эпизода: что реализовано, исправлено, решено */
  items: v.pipe(v.array(Text(500)), v.maxLength(20)),
});

export const ExtractResult = v.object({
  work: v.object({
    /** Одна фраза о результате сегмента */
    summary: Text(500),
    episodes: v.pipe(v.array(Episode), v.maxLength(50)),
  }),
  knowledge: Knowledge,
  usage: Usage,
});

/** Ключ проекта, локальный в пределах отчёта */
const ProjectKey = Text(100);

const Report = v.object({
  version: v.literal(2),
  /** Только chronicle replay: отчёт заменяет все прежние сегменты сессии */
  replace: v.optional(v.literal(true)),
  session: Session,
  launch: v.object({ cwd: Text(1000), projectKey: v.nullable(ProjectKey) }),
  projects: v.pipe(
    v.array(
      v.object({
        key: ProjectKey,
        /** Нормализованный git remote (github.com/owner/repo) — идентичность проекта */
        remote: v.optional(Text(300)),
        name: Text(100),
        /** Корень git-репозитория */
        path: Text(1000),
      }),
    ),
    v.maxLength(100),
  ),
  activity: Activity,
  turns: v.pipe(
    v.array(v.object({ idx: TurnNo, at: Timestamp, projectKey: v.nullable(ProjectKey), focus: v.nullable(Focus) })),
    v.maxLength(10_000),
  ),
  work: v.object({
    summary: Text(500),
    outcomes: v.pipe(
      v.array(v.object({ projectKey: v.nullable(ProjectKey), focus: v.nullable(Focus), text: Text(500) })),
      v.maxLength(500),
    ),
    commits: v.array(v.object({ projectKey: ProjectKey, hash: Text(64), subject: Text(500), at: Timestamp })),
    files: v.array(v.object({ projectKey: ProjectKey, path: Text(1000) })),
  }),
  knowledge: Knowledge,
  usage: Usage,
});

type Report = v.InferOutput<typeof Report>;

function v2Issues(r: Report): string[] {
  const issues = envelopeIssues(r);
  const keys = new Set(r.projects.map((p) => p.key));
  if (keys.size !== r.projects.length) issues.push('ключи проектов повторяются');

  const refs = [
    r.launch.projectKey,
    ...r.turns.map((t) => t.projectKey),
    ...r.work.outcomes.map((o) => o.projectKey),
    ...r.work.commits.map((c) => c.projectKey),
    ...r.work.files.map((f) => f.projectKey),
  ];
  const unknown = [...new Set(refs.filter((k) => k !== null && !keys.has(k)))];
  if (unknown.length > 0) issues.push(`неизвестные ключи проектов: ${unknown.join(', ')}`);

  if (r.turns.some((t, i) => i > 0 && t.idx <= (r.turns[i - 1]?.idx ?? 0))) {
    issues.push('номера ходов не по возрастанию');
  }
  if (r.turns.some((t) => t.at < r.session.startedAt || t.at > r.session.endedAt)) {
    issues.push('ходы вне интервала сегмента');
  }
  return issues;
}

export const SessionReport = v.pipe(Report, reportCheck<Report>(v2Issues));

export type Episode = v.InferOutput<typeof Episode>;
export type ExtractResult = v.InferOutput<typeof ExtractResult>;
export type SessionReport = v.InferOutput<typeof SessionReport>;
