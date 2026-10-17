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

export interface HistoryItem {
  at: string;
  candidateId: number | null;
  action: 'created' | 'merged' | 'archived' | 'imported';
  note: string;
}

export interface CandidateState {
  status: 'pending' | 'created' | 'merged' | 'discarded';
  entryId: string | null;
  decisionNote: string | null;
  attempts: number;
  lastError: string | null;
}

export interface Store {
  transaction<T>(fn: () => T): T;
  /** Проект по remote, иначе по host+path (запоминает новые связки найденного); null — не найден. */
  matchProject(ref: ProjectRef): string | null;
  createProject(ref: ProjectRef): string;
  /** Проект по нормализованному remote, без побочных эффектов */
  findProjectByRemote(remote: string): string | null;
  findSegmentId(agent: string, agentSessionId: string, seq: number): number | null;
  /** Сохраняет сегмент целиком (сессия, активность, результат, кандидаты); возвращает ID сегмента. */
  insertSegment(projectId: string, report: SessionReport): number;
  existingEntryIds(ids: string[]): Set<string>;
  /** Учёт пользы; обновляет время последнего использования записи. */
  insertUsage(entryId: string, segmentId: number | null, helped: boolean | null, at?: string): void;
  insertEntry(entry: NewEntry): void;
  archiveEntry(id: string): void;
  /** Активные записи проекта и общего scope (projectId = null — только общие). */
  activeEntries(projectId: string | null): KnowledgeEntry[];
  getEntry(id: string): KnowledgeEntry | null;
  markFound(ids: string[]): void;
  markOpened(id: string): void;
  getSegment(id: number): StoredSegment | null;
  pendingCandidates(): PendingCandidate[];
  candidate(id: number): CandidateState | null;
  /** Решение курирования по кандидату */
  decideCandidate(id: number, status: 'created' | 'merged' | 'discarded', entryId: string | null, note: string): void;
  /** Неудачная попытка курирования: кандидат остаётся pending */
  failCandidate(id: number, error: string): void;
  updateEntry(id: string, fields: Omit<NewEntry, 'id'>): void;
  addHistory(entryId: string, candidateId: number | null, action: HistoryItem['action'], note: string): void;
  entryHistory(entryId: string): HistoryItem[];
  /** Активные записи, не использовавшиеся (и не созданные) после cutoff */
  staleEntryIds(cutoff: string): string[];
}
