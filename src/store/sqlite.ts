// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * A thin wrapper around node:sqlite (design 3, 9.2). node:sqlite is still under active development, so all calls go through this layer,
 * and only this file needs a look when upgrading Node minor versions. All SQL is parameterized.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Param = SQLInputValue;

export interface Db {
  exec(sql: string): void;
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[];
  run(sql: string, ...params: Param[]): { changes: number };
  tx<T>(fn: () => T): T;
  close(): void;
}

/** Schema version (PRAGMA user_version). Add one migration for each schema change, and never edit existing migrations. */
const MIGRATIONS: string[] = [
  // v1: initial schema (0.1.x)
  `
CREATE TABLE IF NOT EXISTS sessions (
  session_key        TEXT PRIMARY KEY,
  app_id             TEXT NOT NULL,
  chat_id            TEXT NOT NULL,
  thread_id          TEXT,
  user_key           TEXT NOT NULL,
  epoch              INTEGER NOT NULL DEFAULT 0,
  agent_alias        TEXT,
  runtime_session_id TEXT NOT NULL,
  usage_totals       TEXT NOT NULL DEFAULT '{}',
  last_prompt        TEXT,
  last_turn_at       INTEGER,
  last_turn_ms       INTEGER
);
CREATE TABLE IF NOT EXISTS seen_events (
  event_id TEXT PRIMARY KEY,
  seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_events_seen_at ON seen_events(seen_at);
CREATE TABLE IF NOT EXISTS turns (
  turn_id        TEXT PRIMARY KEY,
  session_key    TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  first_token_ms INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cache_read     INTEGER,
  cache_write    INTEGER,
  model          TEXT,
  result         TEXT,
  error_code     TEXT
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_key, started_at);
`,
  // v2: each agent keeps its own current conversation (design 5.4).
  // The runtimeSessionId algorithm now includes the alias, so old conversations cannot be continued; epoch / usage are not migrated; last_prompt and the current alias are kept.
  `
CREATE TABLE sessions_v2 (
  session_key  TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  thread_id    TEXT,
  user_key     TEXT NOT NULL,
  agent_alias  TEXT,
  last_prompt  TEXT,
  last_turn_at INTEGER
);
INSERT INTO sessions_v2(session_key, app_id, chat_id, thread_id, user_key, agent_alias, last_prompt, last_turn_at)
  SELECT session_key, app_id, chat_id, thread_id, user_key, agent_alias, last_prompt, last_turn_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_v2 RENAME TO sessions;
CREATE TABLE session_agents (
  session_key        TEXT NOT NULL,
  agent_alias        TEXT NOT NULL,
  epoch              INTEGER NOT NULL DEFAULT 0,
  runtime_session_id TEXT NOT NULL,
  runtime_arn        TEXT,
  usage_totals       TEXT NOT NULL DEFAULT '{}',
  last_turn_at       INTEGER,
  last_turn_ms       INTEGER,
  PRIMARY KEY (session_key, agent_alias)
);
ALTER TABLE turns ADD COLUMN agent_alias TEXT;
`,
  // v3: the conversation list used by /resume (design 8.1, 9.2). title is controlled by storePromptText and may be empty.
  `
CREATE TABLE conversations (
  session_key  TEXT NOT NULL,
  agent_alias  TEXT NOT NULL,
  epoch        INTEGER NOT NULL,
  title        TEXT,
  started_at   INTEGER NOT NULL,
  last_turn_at INTEGER NOT NULL,
  usage_totals TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_key, agent_alias, epoch)
);
CREATE INDEX conversations_last ON conversations(last_turn_at);
`,
  // v4: scheduled tasks (design 8.3)
  `
CREATE TABLE schedules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id            TEXT NOT NULL,
  session_key       TEXT NOT NULL,
  union_id          TEXT NOT NULL,
  tenant_key        TEXT NOT NULL,
  chat_id           TEXT NOT NULL,
  chat_type         TEXT NOT NULL,
  thread_id         TEXT,
  source_message_id TEXT NOT NULL,
  spec              TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  next_run_at       INTEGER NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);
CREATE INDEX schedules_due ON schedules(enabled, next_run_at);
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: DatabaseSync): void {
  const cur = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    get: <T>(sql: string, ...params: Param[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: Param[]) => db.prepare(sql).all(...params) as T[],
    run: (sql, ...params) => ({ changes: Number(db.prepare(sql).run(...params).changes) }),
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}
