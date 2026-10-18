/** Сырые факты работы за период (GET /v1/facts) — основа для chronicle report day и внешних отчётов. */
import type { Store, StoredSegment } from './store.ts';

export interface FactsQuery {
  from: string;
  to: string;
  /** null — все люди */
  person: string | null;
  project: string | null;
}

export interface Facts {
  from: string;
  to: string;
  /** Настройки сервиса, по которым строятся проекции */
  settings: { idleGapMinutes: number; timezone: string };
  projects: { id: string; name: string }[];
  /** Сегменты, пересекающие период; пересобранные (superseded) исключены */
  segments: StoredSegment[];
}

/** Сегмент касается проекта: проект запуска или проект любого хода, результата, коммита */
function touches(s: StoredSegment, project: string): boolean {
  return (
    s.launchProject === project ||
    [...s.turns, ...s.outcomes, ...s.commits, ...s.files].some((x) => x.projectId === project)
  );
}

export function getFacts(store: Store, q: FactsQuery, settings: Facts['settings']): Facts {
  const segments = store
    .segmentsBetween(q.from, q.to, q.person)
    .filter((s) => q.project === null || touches(s, q.project));
  return { from: q.from, to: q.to, settings, projects: store.projects(), segments };
}
