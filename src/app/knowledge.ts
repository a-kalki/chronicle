import { queryScore } from '../domain/similarity.ts';
import type { KnowledgeEntry, ProjectRef, Store } from './store.ts';

export interface SearchHit {
  id: string;
  /** 'global' или ID проекта */
  scope: string;
  kind: KnowledgeEntry['kind'];
  title: string;
  score: number;
}

export interface SearchQuery {
  q: string;
  /** Откуда ищут: по нему определяется проект; записи чужих проектов не показываются */
  project: ProjectRef;
  limit?: number;
  minScore?: number;
}

/** Текст записи для поиска: дословные симптомы — главный ключ. */
export function entryText(e: Pick<KnowledgeEntry, 'id' | 'title' | 'symptoms' | 'tags'>): string {
  return [e.id, e.title, ...e.symptoms, ...e.tags].join(' ');
}

/** Нечёткий поиск из рабочего каталога агента: проект определяется по remote или host+path. */
export function searchKnowledge(store: Store, query: SearchQuery): SearchHit[] {
  return searchEntries(store, { ...query, projectId: store.matchProject(query.project) });
}

/**
 * Нечёткий поиск по активным записям проекта (null — только общие) и общего scope;
 * учитывает попадание в выдачу.
 */
export function searchEntries(
  store: Store,
  query: { q: string; projectId: string | null; limit?: number; minScore?: number },
): SearchHit[] {
  const { q, projectId, limit = 10, minScore = 0.4 } = query;

  const hits = store
    .activeEntries(projectId)
    .map((e) => ({
      id: e.id,
      scope: e.projectId ?? 'global',
      kind: e.kind,
      title: e.title,
      score: queryScore(q, entryText(e)),
    }))
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  store.markFound(hits.map((h) => h.id));
  return hits;
}

/** Запись целиком; учитывает открытие. */
export function getEntry(store: Store, id: string): KnowledgeEntry | null {
  if (!store.getEntry(id)) return null;
  store.markOpened(id);
  return store.getEntry(id);
}

/** Отметка пользы вне отчёта сегмента; false — записи нет. */
export function recordUsage(store: Store, id: string, helped: boolean | null): boolean {
  if (!store.getEntry(id)) return false;
  store.insertUsage(id, null, helped);
  return true;
}
