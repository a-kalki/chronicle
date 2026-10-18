import * as v from 'valibot';
import * as V1 from '../../contract/v1.ts';
import * as V2 from '../../contract/v2.ts';
import { mainProject } from '../domain/turn-project.ts';
import type { NewSegment, Store } from './store.ts';

export type SubmitReportResult =
  | { ok: true; duplicate: boolean; segmentId: number; candidates: number; unknownEntries: string[] }
  | { ok: false; issues: string[] };

/** Сегмент v1 — без ходов: весь интервал и все факты относятся к проекту запуска */
function fromV1(store: Store, r: V1.SessionReport, person: string | null): NewSegment {
  const ref = { ...r.project, host: r.session.host };
  const projectId = store.matchProject(ref) ?? store.createProject(ref);
  return {
    ...segmentBase(r, person),
    cwd: r.project.path,
    launchProject: projectId,
    summary: r.work.summary,
    turns: [],
    outcomes: r.work.items.map((text) => ({ projectId, focus: null, text })),
    commits: r.work.commits.map((c) => ({ ...c, projectId })),
    files: r.work.files.map((path) => ({ projectId, path })),
    knowledge: r.knowledge.map((k) => ({ ...k, projectId })),
  };
}

function fromV2(store: Store, r: V2.SessionReport, person: string | null): NewSegment {
  const ids = new Map<string, string>();
  for (const { key, ...p } of r.projects) {
    const ref = { ...p, host: r.session.host };
    ids.set(key, store.matchProject(ref) ?? store.createProject(ref));
  }
  const id = (key: string | null) => (key === null ? null : (ids.get(key) ?? null));
  const turns = r.turns.map((t) => ({ idx: t.idx, at: t.at, projectId: id(t.projectKey), focus: t.focus }));
  const launchProject = id(r.launch.projectKey);
  const main = mainProject(
    turns.map((t) => t.projectId),
    launchProject,
  );
  return {
    ...segmentBase(r, person),
    cwd: r.launch.cwd,
    launchProject,
    summary: r.work.summary,
    turns,
    outcomes: r.work.outcomes.map((o) => ({ projectId: id(o.projectKey), focus: o.focus, text: o.text })),
    commits: r.work.commits.map(({ projectKey, ...c }) => ({ ...c, projectId: id(projectKey) })),
    files: r.work.files.map((f) => ({ projectId: id(f.projectKey), path: f.path })),
    knowledge: r.knowledge.map((k) => ({ ...k, projectId: main })),
  };
}

function segmentBase(r: V1.SessionReport | V2.SessionReport, person: string | null) {
  const s = r.session;
  return {
    agent: s.agent,
    agentSessionId: s.id,
    host: s.host,
    person,
    seq: s.seq,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    activitySource: r.activity.source,
    events: r.activity.events,
  };
}

/**
 * Приём отчёта сегмента: валидация по контракту (v2, либо v1 — накопленный outbox старых клиентов),
 * идемпотентность по (agent, sessionId, seq), всё сохраняется одной транзакцией.
 * replace (пересборка сессии) помечает прежние сегменты сессии superseded. Курирование знаний — отдельно.
 * person — человек, которому сопоставлен токен отчёта.
 */
export function submitReport(store: Store, input: unknown, person: string | null = null): SubmitReportResult {
  const isV2 = (input as { version?: unknown } | null)?.version === 2;
  const parsed = isV2 ? v.safeParse(V2.SessionReport, input) : v.safeParse(V1.SessionReport, input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.issues.map((i) => `${v.getDotPath(i) ?? '(корень)'}: ${i.message}`),
    };
  }
  const report = parsed.output;
  const { session } = report;

  return store.transaction(() => {
    const existing = store.findSegmentId(session.agent, session.id, session.seq);
    if (existing !== null) {
      return { ok: true, duplicate: true, segmentId: existing, candidates: 0, unknownEntries: [] };
    }

    if (report.version === 2 && report.replace) store.supersedeSession(session.agent, session.id);
    const segment = report.version === 2 ? fromV2(store, report, person) : fromV1(store, report, person);
    const segmentId = store.insertSegment(segment);

    const known = store.existingEntryIds(report.usage.map((u) => u.entryId));
    const unknownEntries: string[] = [];
    for (const u of report.usage) {
      if (known.has(u.entryId)) store.insertUsage(u.entryId, segmentId, u.helped);
      else unknownEntries.push(u.entryId);
    }

    return { ok: true, duplicate: false, segmentId, candidates: report.knowledge.length, unknownEntries };
  });
}
