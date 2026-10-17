/**
 * Контракт v1: что агенты доставляют в chronicle.
 *
 * ExtractResult — выжимка, которую формирует сам агент (дешёвой моделью) по общему промпту.
 * SessionReport — полный отчёт сегмента сессии: выжимка + то, что адаптер собирает сам
 * (идентичность, активность, коммиты, файлы). Агенту эти поля не доверяются.
 */
import * as v from 'valibot';

const Slug = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/, 'ожидается slug: a-z, 0-9, дефис'), v.maxLength(64));
const Timestamp = v.pipe(v.string(), v.isoTimestamp('ожидается ISO 8601 с зоной'));
const Text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));

export const KnowledgeCandidate = v.object({
  scope: v.picklist(['project', 'global']),
  /** trap — ловушка (симптом → причина → решение); fact — неочевидный факт окружения */
  kind: v.picklist(['trap', 'fact']),
  title: Text(200),
  /** Дословные тексты ошибок — главный ключ поиска */
  symptoms: v.pipe(v.array(Text(1000)), v.maxLength(10)),
  cause: Text(2000),
  fix: Text(4000),
  tags: v.pipe(v.array(Text(40)), v.maxLength(10)),
});

export const KnowledgeUsage = v.object({
  entryId: Text(200),
  /** null — открыта, но непонятно, помогла ли */
  helped: v.nullable(v.boolean()),
});

export const ExtractResult = v.object({
  work: v.object({
    /** Одна фраза о бизнес-результате сегмента */
    summary: Text(500),
    items: v.pipe(v.array(Text(500)), v.maxLength(50)),
  }),
  knowledge: v.pipe(v.array(KnowledgeCandidate), v.maxLength(20)),
  usage: v.pipe(v.array(KnowledgeUsage), v.maxLength(50)),
});

const ActivityEvent = v.object({
  at: Timestamp,
  actor: v.picklist(['user', 'agent']),
});

export const SessionReport = v.pipe(
  v.object({
    version: v.literal(1),
    session: v.object({
      agent: Slug,
      id: Text(200),
      host: Slug,
      /** Номер сегмента: каждый /finish одной сессии — следующий */
      seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
      startedAt: Timestamp,
      endedAt: Timestamp,
    }),
    project: v.object({
      /** Нормализованный git remote (github.com/owner/repo) — идентичность проекта */
      remote: v.optional(Text(300)),
      name: Text(100),
      path: Text(1000),
    }),
    activity: v.object({
      /** log — метки из лога сессии; coarse — лог недоступен, известен только интервал */
      source: v.picklist(['log', 'coarse']),
      events: v.pipe(v.array(ActivityEvent), v.maxLength(100_000)),
    }),
    work: v.object({
      ...ExtractResult.entries.work.entries,
      commits: v.array(v.object({ hash: Text(64), subject: Text(500), at: Timestamp })),
      files: v.array(Text(1000)),
    }),
    knowledge: ExtractResult.entries.knowledge,
    usage: ExtractResult.entries.usage,
  }),
  v.check((r) => r.session.startedAt <= r.session.endedAt, 'endedAt раньше startedAt'),
  v.check(
    (r) => r.activity.source === 'log' || r.activity.events.length === 0,
    'при coarse-активности события не передаются',
  ),
  v.check(
    (r) => r.activity.events.every((e) => e.at >= r.session.startedAt && e.at <= r.session.endedAt),
    'события активности вне интервала сегмента',
  ),
);

export type KnowledgeCandidate = v.InferOutput<typeof KnowledgeCandidate>;
export type ExtractResult = v.InferOutput<typeof ExtractResult>;
export type SessionReport = v.InferOutput<typeof SessionReport>;
