import { Database } from 'bun:sqlite';
import type { SessionReport } from '../../contract/v1.ts';
import type {
  CandidateState,
  HistoryItem,
  KnowledgeEntry,
  NewEntry,
  PendingCandidate,
  ProjectRef,
  Store,
  StoredSegment,
} from '../app/store.ts';
import { MIGRATIONS } from './migrations.ts';

const now = () => new Date().toISOString();

interface EntryRow {
  id: string;
  project_id: string | null;
  kind: 'trap' | 'fact';
  title: string;
  symptoms: string;
  cause: string;
  fix: string;
  tags: string;
  status: 'active' | 'archived';
  found: number;
  opened: number;
  helped: number;
  not_helped: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Запись со счётчиками пользы из knowledge_usage. */
const ENTRY_SELECT = `
  SELECT e.*,
    (SELECT COUNT(*) FROM knowledge_usage u WHERE u.entry_id = e.id AND u.helped = 1) AS helped,
    (SELECT COUNT(*) FROM knowledge_usage u WHERE u.entry_id = e.id AND u.helped = 0) AS not_helped
  FROM knowledge_entries e`;

function toEntry(r: EntryRow): KnowledgeEntry {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    title: r.title,
    symptoms: JSON.parse(r.symptoms),
    cause: r.cause,
    fix: r.fix,
    tags: JSON.parse(r.tags),
    status: r.status,
    found: r.found,
    opened: r.opened,
    helped: r.helped,
    notHelped: r.not_helped,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

export class SqliteStore implements Store {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Ищет проект по remote, затем по host+path; запоминает новые связки найденного проекта. */
  matchProject(ref: ProjectRef): string | null {
    const byRemote = ref.remote
      ? this.db
          .query<{ project_id: string }, [string]>('SELECT project_id FROM project_remotes WHERE remote = ?')
          .get(ref.remote)
      : null;
    const byPath = byRemote
      ? null
      : this.db
          .query<{ project_id: string }, [string, string]>(
            'SELECT project_id FROM project_paths WHERE host = ? AND path = ?',
          )
          .get(ref.host, ref.path);
    const projectId = (byRemote ?? byPath)?.project_id ?? null;
    if (projectId) this.link(projectId, ref);
    return projectId;
  }

  findProjectByRemote(remote: string): string | null {
    const exact = this.db
      .query<{ project_id: string }, [string]>('SELECT project_id FROM project_remotes WHERE remote = ?')
      .get(remote);
    if (exact) return exact.project_id;
    const repoPath = remote.slice(remote.indexOf('/'));
    const bySuffix = this.db
      .query<{ project_id: string }, [string]>(
        "SELECT DISTINCT project_id FROM project_remotes WHERE substr(remote, instr(remote, '/')) = ?",
      )
      .all(repoPath);
    return bySuffix.length === 1 ? (bySuffix[0]?.project_id ?? null) : null;
  }

  createProject(ref: ProjectRef): string {
    const base = slugify(ref.name);
    let id = base;
    for (let n = 2; this.db.query('SELECT 1 FROM projects WHERE id = ?').get(id); n++) id = `${base}-${n}`;
    this.db.run('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', [id, ref.name, now()]);
    this.link(id, ref);
    return id;
  }

  private link(projectId: string, ref: ProjectRef): void {
    if (ref.remote) {
      this.db.run('INSERT OR IGNORE INTO project_remotes (remote, project_id) VALUES (?, ?)', [ref.remote, projectId]);
    }
    this.db.run('INSERT OR IGNORE INTO project_paths (host, path, project_id) VALUES (?, ?, ?)', [
      ref.host,
      ref.path,
      projectId,
    ]);
  }

  findSegmentId(agent: string, agentSessionId: string, seq: number): number | null {
    const row = this.db
      .query<{ id: number }, [string, string, number]>(
        `SELECT g.id FROM segments g JOIN sessions s ON s.id = g.session_id
         WHERE s.agent = ? AND s.agent_session_id = ? AND g.seq = ?`,
      )
      .get(agent, agentSessionId, seq);
    return row?.id ?? null;
  }

  insertSegment(projectId: string, r: SessionReport): number {
    const s = r.session;
    this.db.run(
      `INSERT INTO sessions (agent, agent_session_id, host, project_id, cwd) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (agent, agent_session_id) DO NOTHING`,
      [s.agent, s.id, s.host, projectId, r.project.path],
    );
    const sessionId = this.db
      .query<{ id: number }, [string, string]>('SELECT id FROM sessions WHERE agent = ? AND agent_session_id = ?')
      .get(s.agent, s.id)?.id;

    const segmentId = Number(
      this.db.run(
        `INSERT INTO segments (session_id, seq, started_at, ended_at, activity_source, summary, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sessionId ?? null, s.seq, s.startedAt, s.endedAt, r.activity.source, r.work.summary, now()],
      ).lastInsertRowid,
    );

    const event = this.db.prepare('INSERT INTO activity_events (segment_id, at, actor) VALUES (?, ?, ?)');
    for (const e of r.activity.events) event.run(segmentId, e.at, e.actor);
    const item = this.db.prepare('INSERT INTO work_items (segment_id, pos, text) VALUES (?, ?, ?)');
    for (const [pos, text] of r.work.items.entries()) item.run(segmentId, pos, text);
    const commit = this.db.prepare('INSERT INTO commits (segment_id, hash, subject, at) VALUES (?, ?, ?, ?)');
    for (const c of r.work.commits) commit.run(segmentId, c.hash, c.subject, c.at);
    const file = this.db.prepare('INSERT INTO segment_files (segment_id, path) VALUES (?, ?)');
    for (const f of r.work.files) file.run(segmentId, f);

    const candidate = this.db.prepare(
      `INSERT INTO knowledge_candidates (segment_id, scope, kind, title, symptoms, cause, fix, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const k of r.knowledge) {
      candidate.run(
        segmentId,
        k.scope,
        k.kind,
        k.title,
        JSON.stringify(k.symptoms),
        k.cause,
        k.fix,
        JSON.stringify(k.tags),
      );
    }
    return segmentId;
  }

  existingEntryIds(ids: string[]): Set<string> {
    if (ids.length === 0) return new Set();
    const rows = this.db
      .query<{ id: string }, string[]>(`SELECT id FROM knowledge_entries WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids);
    return new Set(rows.map((r) => r.id));
  }

  insertUsage(entryId: string, segmentId: number | null, helped: boolean | null, at = now()): void {
    this.db.run('INSERT INTO knowledge_usage (entry_id, segment_id, helped, at) VALUES (?, ?, ?, ?)', [
      entryId,
      segmentId,
      helped === null ? null : Number(helped),
      at,
    ]);
    this.db.run('UPDATE knowledge_entries SET last_used_at = ? WHERE id = ?', [at, entryId]);
  }

  insertEntry(e: NewEntry): void {
    const at = now();
    this.db.run(
      `INSERT INTO knowledge_entries (id, project_id, kind, title, symptoms, cause, fix, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.projectId, e.kind, e.title, JSON.stringify(e.symptoms), e.cause, e.fix, JSON.stringify(e.tags), at, at],
    );
  }

  archiveEntry(id: string): void {
    this.db.run("UPDATE knowledge_entries SET status = 'archived', updated_at = ? WHERE id = ?", [now(), id]);
  }

  activeEntries(projectId: string | null): KnowledgeEntry[] {
    return this.db
      .query<EntryRow, [string | null]>(
        `${ENTRY_SELECT} WHERE e.status = 'active' AND (e.project_id IS NULL OR e.project_id = ?)`,
      )
      .all(projectId)
      .map(toEntry);
  }

  getEntry(id: string): KnowledgeEntry | null {
    const row = this.db.query<EntryRow, [string]>(`${ENTRY_SELECT} WHERE e.id = ?`).get(id);
    return row ? toEntry(row) : null;
  }

  markFound(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE knowledge_entries SET found = found + 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  markOpened(id: string): void {
    this.db.run('UPDATE knowledge_entries SET opened = opened + 1, last_used_at = ? WHERE id = ?', [now(), id]);
  }

  getSegment(id: number): StoredSegment | null {
    const row = this.db
      .query<
        {
          id: number;
          project_id: string;
          agent: string;
          agent_session_id: string;
          host: string;
          seq: number;
          started_at: string;
          ended_at: string;
          activity_source: 'log' | 'coarse';
          summary: string;
        },
        [number]
      >(
        `SELECT g.id, s.project_id, s.agent, s.agent_session_id, s.host, g.seq, g.started_at, g.ended_at,
                g.activity_source, g.summary
         FROM segments g JOIN sessions s ON s.id = g.session_id WHERE g.id = ?`,
      )
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      agent: row.agent,
      agentSessionId: row.agent_session_id,
      host: row.host,
      seq: row.seq,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      activitySource: row.activity_source,
      summary: row.summary,
      items: this.db
        .query<{ text: string }, [number]>('SELECT text FROM work_items WHERE segment_id = ? ORDER BY pos')
        .all(id)
        .map((r) => r.text),
      events: this.db
        .query<{ at: string; actor: 'user' | 'agent' }, [number]>(
          'SELECT at, actor FROM activity_events WHERE segment_id = ? ORDER BY at',
        )
        .all(id),
      commits: this.db
        .query<{ hash: string; subject: string; at: string }, [number]>(
          'SELECT hash, subject, at FROM commits WHERE segment_id = ? ORDER BY at',
        )
        .all(id),
      files: this.db
        .query<{ path: string }, [number]>('SELECT path FROM segment_files WHERE segment_id = ?')
        .all(id)
        .map((r) => r.path),
    };
  }

  pendingCandidates(): PendingCandidate[] {
    return this.db
      .query<
        {
          id: number;
          segment_id: number;
          project_id: string;
          scope: 'project' | 'global';
          kind: 'trap' | 'fact';
          title: string;
          symptoms: string;
          cause: string;
          fix: string;
          tags: string;
        },
        []
      >(
        `SELECT c.id, c.segment_id, s.project_id, c.scope, c.kind, c.title, c.symptoms, c.cause, c.fix, c.tags
         FROM knowledge_candidates c
         JOIN segments g ON g.id = c.segment_id JOIN sessions s ON s.id = g.session_id
         WHERE c.status = 'pending' ORDER BY c.id`,
      )
      .all()
      .map((r) => ({
        id: r.id,
        segmentId: r.segment_id,
        projectId: r.project_id,
        scope: r.scope,
        kind: r.kind,
        title: r.title,
        symptoms: JSON.parse(r.symptoms),
        cause: r.cause,
        fix: r.fix,
        tags: JSON.parse(r.tags),
      }));
  }

  candidate(id: number): CandidateState | null {
    const row = this.db
      .query<
        {
          status: CandidateState['status'];
          entry_id: string | null;
          decision_note: string | null;
          attempts: number;
          last_error: string | null;
        },
        [number]
      >('SELECT status, entry_id, decision_note, attempts, last_error FROM knowledge_candidates WHERE id = ?')
      .get(id);
    return row
      ? {
          status: row.status,
          entryId: row.entry_id,
          decisionNote: row.decision_note,
          attempts: row.attempts,
          lastError: row.last_error,
        }
      : null;
  }

  decideCandidate(id: number, status: 'created' | 'merged' | 'discarded', entryId: string | null, note: string): void {
    this.db.run(
      `UPDATE knowledge_candidates
       SET status = ?, entry_id = ?, decision_note = ?, decided_at = ?, attempts = attempts + 1, last_error = NULL
       WHERE id = ?`,
      [status, entryId, note, now(), id],
    );
  }

  failCandidate(id: number, error: string): void {
    this.db.run('UPDATE knowledge_candidates SET attempts = attempts + 1, last_error = ? WHERE id = ?', [error, id]);
  }

  updateEntry(id: string, e: Omit<NewEntry, 'id'>): void {
    this.db.run(
      `UPDATE knowledge_entries
       SET project_id = ?, kind = ?, title = ?, symptoms = ?, cause = ?, fix = ?, tags = ?, updated_at = ?
       WHERE id = ?`,
      [e.projectId, e.kind, e.title, JSON.stringify(e.symptoms), e.cause, e.fix, JSON.stringify(e.tags), now(), id],
    );
  }

  addHistory(entryId: string, candidateId: number | null, action: HistoryItem['action'], note: string): void {
    this.db.run('INSERT INTO knowledge_history (entry_id, at, candidate_id, action, note) VALUES (?, ?, ?, ?, ?)', [
      entryId,
      now(),
      candidateId,
      action,
      note,
    ]);
  }

  entryHistory(entryId: string): HistoryItem[] {
    return this.db
      .query<{ at: string; candidate_id: number | null; action: HistoryItem['action']; note: string }, [string]>(
        'SELECT at, candidate_id, action, note FROM knowledge_history WHERE entry_id = ? ORDER BY rowid',
      )
      .all(entryId)
      .map((r) => ({ at: r.at, candidateId: r.candidate_id, action: r.action, note: r.note }));
  }

  staleEntryIds(cutoff: string): string[] {
    return this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM knowledge_entries
         WHERE status = 'active' AND COALESCE(last_used_at, created_at) < ? ORDER BY id`,
      )
      .all(cutoff)
      .map((r) => r.id);
  }
}

/** Открывает БД, включает WAL и внешние ключи, применяет недостающие миграции. */
export function openStore(path: string): SqliteStore {
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = db.query<{ v: number | null }, []>('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? 0;
  MIGRATIONS.slice(applied).forEach((sql, i) => {
    db.transaction(() => {
      db.run(sql);
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [applied + i + 1, now()]);
    })();
  });
  return new SqliteStore(db);
}
