import * as v from 'valibot';
import { SessionReport } from '../../contract/v1.ts';
import type { Store } from './store.ts';

export type SubmitReportResult =
  | { ok: true; duplicate: boolean; segmentId: number; candidates: number; unknownEntries: string[] }
  | { ok: false; issues: string[] };

/**
 * Приём отчёта сегмента: валидация по контракту, идемпотентность по (agent, sessionId, seq),
 * всё сохраняется одной транзакцией. Курирование знаний — отдельно и асинхронно.
 */
export function submitReport(store: Store, input: unknown): SubmitReportResult {
  const parsed = v.safeParse(SessionReport, input);
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

    const ref = { ...report.project, host: session.host };
    const projectId = store.matchProject(ref) ?? store.createProject(ref);
    const segmentId = store.insertSegment(projectId, report);

    const known = store.existingEntryIds(report.usage.map((u) => u.entryId));
    const unknownEntries: string[] = [];
    for (const u of report.usage) {
      if (known.has(u.entryId)) store.insertUsage(u.entryId, segmentId, u.helped);
      else unknownEntries.push(u.entryId);
    }

    return { ok: true, duplicate: false, segmentId, candidates: report.knowledge.length, unknownEntries };
  });
}
