/** Миграции схемы SQLite: применяются по порядку, номер — индекс + 1. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE project_remotes (
    remote TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id)
  );
  CREATE TABLE project_paths (
    host TEXT NOT NULL,
    path TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    PRIMARY KEY (host, path)
  );

  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    agent TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    host TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    cwd TEXT NOT NULL,
    UNIQUE (agent, agent_session_id)
  );
  CREATE TABLE segments (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    activity_source TEXT NOT NULL CHECK (activity_source IN ('log', 'coarse')),
    summary TEXT NOT NULL,
    received_at TEXT NOT NULL,
    UNIQUE (session_id, seq)
  );
  CREATE INDEX segments_started_at ON segments(started_at);
  CREATE TABLE activity_events (
    segment_id INTEGER NOT NULL REFERENCES segments(id),
    at TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user', 'agent'))
  );
  CREATE INDEX activity_events_segment ON activity_events(segment_id);
  CREATE TABLE work_items (
    segment_id INTEGER NOT NULL REFERENCES segments(id),
    pos INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE commits (
    segment_id INTEGER NOT NULL REFERENCES segments(id),
    hash TEXT NOT NULL,
    subject TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE segment_files (
    segment_id INTEGER NOT NULL REFERENCES segments(id),
    path TEXT NOT NULL
  );

  CREATE TABLE knowledge_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id), -- NULL — общий scope
    kind TEXT NOT NULL CHECK (kind IN ('trap', 'fact')),
    title TEXT NOT NULL,
    symptoms TEXT NOT NULL, -- JSON-массив
    cause TEXT NOT NULL,
    fix TEXT NOT NULL,
    tags TEXT NOT NULL,     -- JSON-массив
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    found INTEGER NOT NULL DEFAULT 0,
    opened INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE knowledge_candidates (
    id INTEGER PRIMARY KEY,
    segment_id INTEGER NOT NULL REFERENCES segments(id),
    scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
    kind TEXT NOT NULL CHECK (kind IN ('trap', 'fact')),
    title TEXT NOT NULL,
    symptoms TEXT NOT NULL,
    cause TEXT NOT NULL,
    fix TEXT NOT NULL,
    tags TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'merged', 'discarded')),
    entry_id TEXT REFERENCES knowledge_entries(id),
    decision_note TEXT,
    decided_at TEXT
  );
  CREATE INDEX knowledge_candidates_status ON knowledge_candidates(status);
  CREATE TABLE knowledge_history (
    entry_id TEXT NOT NULL REFERENCES knowledge_entries(id),
    at TEXT NOT NULL,
    candidate_id INTEGER REFERENCES knowledge_candidates(id),
    action TEXT NOT NULL,
    note TEXT NOT NULL
  );
  CREATE TABLE knowledge_usage (
    entry_id TEXT NOT NULL REFERENCES knowledge_entries(id),
    segment_id INTEGER REFERENCES segments(id),
    helped INTEGER, -- 1/0/NULL
    at TEXT NOT NULL
  );
  `,
];
