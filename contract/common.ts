/** Общие части контрактов v1 и v2. */
import * as v from 'valibot';

export const Slug = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9-]*$/, 'ожидается slug: a-z, 0-9, дефис'),
  v.maxLength(64),
);
export const Timestamp = v.pipe(v.string(), v.isoTimestamp('ожидается ISO 8601 с зоной'));
export const Text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));

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

export const Knowledge = v.pipe(v.array(KnowledgeCandidate), v.maxLength(20));
export const Usage = v.pipe(v.array(KnowledgeUsage), v.maxLength(50));

export const ActivityEvent = v.object({
  at: Timestamp,
  actor: v.picklist(['user', 'agent']),
});

export const Session = v.object({
  agent: Slug,
  id: Text(200),
  host: Slug,
  /** Номер сегмента: каждый /finish одной сессии — следующий */
  seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
  startedAt: Timestamp,
  endedAt: Timestamp,
});

export const Activity = v.object({
  /** log — метки из лога сессии; coarse — лог недоступен, известен только интервал */
  source: v.picklist(['log', 'coarse']),
  events: v.pipe(v.array(ActivityEvent), v.maxLength(100_000)),
});

interface Envelope {
  session: { startedAt: string; endedAt: string };
  activity: { source: 'log' | 'coarse'; events: { at: string }[] };
}

/** Проверки интервала сегмента и активности — одинаковые для всех версий отчёта */
export function envelopeIssues(r: Envelope): string[] {
  const issues: string[] = [];
  if (r.session.startedAt > r.session.endedAt) issues.push('endedAt раньше startedAt');
  if (r.activity.source === 'coarse' && r.activity.events.length > 0) {
    issues.push('при coarse-активности события не передаются');
  }
  if (r.activity.events.some((e) => e.at < r.session.startedAt || e.at > r.session.endedAt)) {
    issues.push('события активности вне интервала сегмента');
  }
  return issues;
}

/** Проверка отчёта целиком: функция возвращает список нарушений */
export function reportCheck<T>(issuesOf: (r: T) => string[]) {
  return v.rawCheck<T>(({ dataset, addIssue }) => {
    if (dataset.typed) for (const message of issuesOf(dataset.value)) addIssue({ message });
  });
}

export type KnowledgeCandidate = v.InferOutput<typeof KnowledgeCandidate>;
export type KnowledgeUsage = v.InferOutput<typeof KnowledgeUsage>;
