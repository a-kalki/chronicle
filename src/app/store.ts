/** Порт хранилища: то, что нужно use case'ам. Реализация — infra/sqlite-store.ts. */
import type { KnowledgeCandidate, SessionReport } from '../../contract/v1.ts';

export interface ProjectRef {
  remote?: string;
  name: string;
  host: string;
  path: string;
}

export interface StoredSegment {
  id: number;
  projectId: string;
  agent: string;
  agentSessionId: string;
  host: string;
  seq: number;
  startedAt: string;
  endedAt: string;
  activitySource: 'log' | 'coarse';
  summary: string;
  items: string[];
  events: { at: string; actor: 'user' | 'agent' }[];
  commits: { hash: string; subject: string; at: string }[];
  files: string[];
}

export interface PendingCandidate extends KnowledgeCandidate {
  id: number;
  segmentId: number;
  projectId: string;
}

export interface Store {
  transaction<T>(fn: () => T): T;
  /** Проект по remote, иначе по host+path (запоминает новые связки найденного); null — не найден. */
  matchProject(ref: ProjectRef): string | null;
  createProject(ref: ProjectRef): string;
  findSegmentId(agent: string, agentSessionId: string, seq: number): number | null;
  /** Сохраняет сегмент целиком (сессия, активность, результат, кандидаты); возвращает ID сегмента. */
  insertSegment(projectId: string, report: SessionReport): number;
  existingEntryIds(ids: string[]): Set<string>;
  insertUsage(entryId: string, segmentId: number, helped: boolean | null): void;
  getSegment(id: number): StoredSegment | null;
  pendingCandidates(): PendingCandidate[];
}
