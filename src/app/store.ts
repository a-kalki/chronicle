/** Порт хранилища: то, что нужно use case'ам. Реализация — infra/sqlite-store.ts. */
import type { KnowledgeCandidate } from '../../contract/common.ts';

export interface ProjectRef {
  remote?: string;
  name: string;
  host: string;
  path: string;
}

/** Ход: проект — по путям инструментов, фокус — от выжимки */
export interface StoredTurn {
  idx: number;
  at: string;
  projectId: string | null;
  focus: string | null;
}

/** Сегмент в форме, не зависящей от версии контракта */
export interface NewSegment {
  agent: string;
  agentSessionId: string;
  host: string;
  /** Человек — по токену, с которым пришёл отчёт */
  person: string | null;
  cwd: string;
  /** Проект каталога запуска; null — запуск вне git */
  launchProject: string | null;
  seq: number;
  startedAt: string;
  endedAt: string;
  activitySource: 'log' | 'coarse';
  summary: string;
  events: { at: string; actor: 'user' | 'agent' }[];
  turns: StoredTurn[];
  outcomes: { projectId: string | null; focus: string | null; text: string }[];
  commits: { projectId: string | null; hash: string; subject: string; at: string }[];
  files: { projectId: string | null; path: string }[];
  /** projectId — проект кандидата со scope project */
  knowledge: (KnowledgeCandidate & { projectId: string | null })[];
}

/**
 * Сохранённый сегмент. projectId результатов, коммитов и файлов старых (v1) сегментов — проект запуска.
 * superseded — факты работы заменены пересборкой сессии и из проекций исключаются.
 */
export interface StoredSegment extends Omit<NewSegment, 'knowledge'> {
  id: number;
  superseded: boolean;
}

export interface PendingCandidate extends KnowledgeCandidate {
  id: number;
  segmentId: number;
  /** null — у сессии нет проекта: кандидат может попасть только в общий scope */
  projectId: string | null;
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
  /**
   * Проект по нормализованному remote, без побочных эффектов. Если точного совпадения нет —
   * по «владелец/репо» без хоста (хост мог прийти SSH-алиасом), только при единственном совпадении.
   */
  findProjectByRemote(remote: string): string | null;
  findSegmentId(agent: string, agentSessionId: string, seq: number): number | null;
  /** Сохраняет сегмент целиком (сессия, активность, ходы, результат, кандидаты); возвращает ID сегмента. */
  insertSegment(segment: NewSegment): number;
  /** Помечает все сегменты сессии superseded (перед записью пересобранного) */
  supersedeSession(agent: string, agentSessionId: string): void;
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
  /** Действующие (не superseded) сегменты, пересекающие [from, to); person = null — все люди */
  segmentsBetween(from: string, to: string, person: string | null): StoredSegment[];
  projects(): { id: string; name: string }[];
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
