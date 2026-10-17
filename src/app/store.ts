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

export interface NewEntry {
  id: string;
  /** null — общий scope */
  projectId: string | null;
  kind: 'trap' | 'fact';
  title: string;
  symptoms: string[];
  cause: string;
  fix: string;
  tags: string[];
}

export interface KnowledgeEntry extends NewEntry {
  status: 'active' | 'archived';
  found: number;
  opened: number;
  helped: number;
  notHelped: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  /** Учёт пользы; обновляет время последнего использования записи. */
  insertUsage(entryId: string, segmentId: number | null, helped: boolean | null): void;
  insertEntry(entry: NewEntry): void;
  archiveEntry(id: string): void;
  /** Активные записи проекта и общего scope (projectId = null — только общие). */
  activeEntries(projectId: string | null): KnowledgeEntry[];
  getEntry(id: string): KnowledgeEntry | null;
  markFound(ids: string[]): void;
  markOpened(id: string): void;
  getSegment(id: number): StoredSegment | null;
  pendingCandidates(): PendingCandidate[];
}
