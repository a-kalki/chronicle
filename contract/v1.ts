/**
 * Контракт v1: что агенты доставляли в chronicle до модели работы v2 (сервис принимает его и дальше —
 * накопленный outbox старых клиентов).
 *
 * ExtractResult — выжимка, которую формирует сам агент (дешёвой моделью) по общему промпту.
 * SessionReport — полный отчёт сегмента сессии: выжимка + то, что адаптер собирает сам
 * (идентичность, активность, коммиты, файлы). Агенту эти поля не доверяются.
 */
import * as v from 'valibot';
import { Activity, envelopeIssues, Knowledge, reportCheck, Session, Text, Timestamp, Usage } from './common.ts';

export { KnowledgeCandidate } from './common.ts';

export const ExtractResult = v.object({
  work: v.object({
    /** Одна фраза о бизнес-результате сегмента */
    summary: Text(500),
    items: v.pipe(v.array(Text(500)), v.maxLength(50)),
  }),
  knowledge: Knowledge,
  usage: Usage,
});

const Report = v.object({
  version: v.literal(1),
  session: Session,
  project: v.object({
    /** Нормализованный git remote (github.com/owner/repo) — идентичность проекта */
    remote: v.optional(Text(300)),
    name: Text(100),
    path: Text(1000),
  }),
  activity: Activity,
  work: v.object({
    ...ExtractResult.entries.work.entries,
    commits: v.array(v.object({ hash: Text(64), subject: Text(500), at: Timestamp })),
    files: v.array(Text(1000)),
  }),
  knowledge: Knowledge,
  usage: Usage,
});

export const SessionReport = v.pipe(Report, reportCheck<v.InferOutput<typeof Report>>(envelopeIssues));

export type ExtractResult = v.InferOutput<typeof ExtractResult>;
export type SessionReport = v.InferOutput<typeof SessionReport>;
