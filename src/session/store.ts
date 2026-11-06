// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Conversation data (design 5.4, 9.2).
 *
 * - `sessions`: one row per conversation location (sessionKey), recording the currently selected agent and last_prompt.
 * - `session_agents`: one row per conversation location × agent alias, recording that agent's current conversation epoch, runtimeSessionId, and usage.
 *   `/agent` switching back to an agent continues its last conversation there; `/new` increments only the current agent's epoch.
 * - `turns`: one record per turn.
 *
 * Message text is not stored, except last_prompt for /retry (it can be turned off with the bot's storePromptText).
 */
import type { Db } from '../store/sqlite.ts';
import { runtimeSessionIdOf } from './keys.ts';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
}

export const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };

/** Used by /retry: text + image / file references (resending downloads them from Feishu again; contents are not stored) */
export interface StoredPrompt {
  text: string;
  images: { messageId: string; imageKey: string }[];
  files?: { messageId: string; fileKey: string; name: string }[];
}

export interface Session {
  sessionKey: string;
  appId: string;
  chatId: string;
  threadId: string | null;
  userKey: string;
  /** Alias of the currently selected agent; null means the bot's defaultAgent */
  agentAlias: string | null;
  lastPrompt: StoredPrompt | null;
  lastTurnAt: number | null;
}

/** The current conversation of an agent at this conversation location */
export interface AgentSession {
  sessionKey: string;
  agentAlias: string;
  epoch: number;
  runtimeSessionId: string;
  usage: UsageTotals;
  lastTurnAt: number | null;
  lastTurnMs: number | null;
}

interface SessionRow {
  session_key: string;
  app_id: string;
  chat_id: string;
  thread_id: string | null;
  user_key: string;
  agent_alias: string | null;
  last_prompt: string | null;
  last_turn_at: number | null;
}

interface AgentRow {
  session_key: string;
  agent_alias: string;
  epoch: number;
  runtime_session_id: string;
  runtime_arn: string | null;
  usage_totals: string;
  last_turn_at: number | null;
  last_turn_ms: number | null;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const num = (v: number | bigint | null): number | null => (v === null ? null : Number(v));

function fromSessionRow(r: SessionRow): Session {
  return {
    sessionKey: r.session_key,
    appId: r.app_id,
    chatId: r.chat_id,
    threadId: r.thread_id,
    userKey: r.user_key,
    agentAlias: r.agent_alias,
    lastPrompt: parseJson<StoredPrompt | null>(r.last_prompt, null),
    lastTurnAt: num(r.last_turn_at),
  };
}

function fromAgentRow(r: AgentRow): AgentSession {
  return {
    sessionKey: r.session_key,
    agentAlias: r.agent_alias,
    epoch: Number(r.epoch),
    runtimeSessionId: r.runtime_session_id,
    usage: { ...ZERO_USAGE, ...parseJson<Partial<UsageTotals>>(r.usage_totals, {}) },
    lastTurnAt: num(r.last_turn_at),
    lastTurnMs: num(r.last_turn_ms),
  };
}

/** One item of the /resume list (design 8.1) */
export interface ConversationInfo {
  epoch: number;
  title: string | null;
  startedAt: number;
  lastTurnAt: number;
  turns: number;
}

/** Conversation retention: the same as the retention of the reference agent's Memory events (design 8.1) */
export const CONVERSATION_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** Conversation title: the first 20 characters of the first message (design 8.1) */
export function conversationTitle(p: StoredPrompt): string {
  const t = p.text.replace(/\s+/g, ' ').trim();
  if (t) return [...t].slice(0, 20).join('');
  if (p.files?.length) return '[文件]';
  if (p.images.length) return '[图片]';
  return '';
}

export interface TurnRecord {
  turnId: string;
  sessionKey: string;
  agentAlias: string;
  startedAt: number;
  endedAt: number;
  firstTokenMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  model: string | null;
  result: 'success' | 'failure' | 'timeout' | 'interrupted';
  errorCode: string | null;
  /** Title of this conversation; passed only on its first turn, and not passed when storePromptText is off */
  title?: string | null;
}

export class SessionStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(sessionKey: string): Session | undefined {
    const r = this.db.get<SessionRow>(
      'SELECT session_key, app_id, chat_id, thread_id, user_key, agent_alias, last_prompt, last_turn_at FROM sessions WHERE session_key = ?',
      sessionKey,
    );
    return r ? fromSessionRow(r) : undefined;
  }

  getOrCreate(init: { sessionKey: string; appId: string; chatId: string; threadId: string | null; userKey: string }): Session {
    const existing = this.get(init.sessionKey);
    if (existing) return existing;
    this.db.run(
      `INSERT OR IGNORE INTO sessions(session_key, app_id, chat_id, thread_id, user_key, agent_alias)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      init.sessionKey,
      init.appId,
      init.chatId,
      init.threadId,
      init.userKey,
    );
    return this.get(init.sessionKey)!;
  }

  /**
   * Read (creating at epoch 0 if missing) the current conversation of an agent at this conversation location.
   * When runtimeArn is passed: the same alias was rebound to another runtime, so a new conversation starts automatically (the old conversation's ID is not given to the new runtime).
   */
  agentSession(sessionKey: string, alias: string, runtimeArn?: string): AgentSession {
    const r = this.db.get<AgentRow>('SELECT * FROM session_agents WHERE session_key = ? AND agent_alias = ?', sessionKey, alias);
    if (r && runtimeArn && r.runtime_arn !== runtimeArn) {
      if (r.runtime_arn) {
        const epoch = Number(r.epoch) + 1;
        this.db.run(
          `UPDATE session_agents SET epoch = ?, runtime_session_id = ?, runtime_arn = ?, usage_totals = '{}', last_turn_at = NULL, last_turn_ms = NULL
           WHERE session_key = ? AND agent_alias = ?`,
          epoch, runtimeSessionIdOf(sessionKey, alias, epoch), runtimeArn, sessionKey, alias,
        );
      } else {
        this.db.run('UPDATE session_agents SET runtime_arn = ? WHERE session_key = ? AND agent_alias = ?', runtimeArn, sessionKey, alias);
      }
      return this.agentSession(sessionKey, alias);
    }
    if (r) return fromAgentRow(r);
    this.db.run(
      `INSERT OR IGNORE INTO session_agents(session_key, agent_alias, epoch, runtime_session_id, runtime_arn) VALUES (?, ?, 0, ?, ?)`,
      sessionKey,
      alias,
      runtimeSessionIdOf(sessionKey, alias, 0),
      runtimeArn ?? null,
    );
    return this.agentSession(sessionKey, alias);
  }

  /** Return only if a record exists (used by /status and /agent to decide whether to "continue the last conversation") */
  peekAgentSession(sessionKey: string, alias: string): AgentSession | undefined {
    const r = this.db.get<AgentRow>('SELECT * FROM session_agents WHERE session_key = ? AND agent_alias = ?', sessionKey, alias);
    return r ? fromAgentRow(r) : undefined;
  }

  /** /new: the current agent moves to an epoch never used before (it also cannot collide with an existing one after switching back to an old conversation), and cumulative usage is reset */
  bumpEpoch(sessionKey: string, alias: string): AgentSession {
    return this.db.tx(() => {
      const cur = this.agentSession(sessionKey, alias);
      const maxConv = this.db.get<{ m: number | null }>(
        'SELECT MAX(epoch) AS m FROM conversations WHERE session_key = ? AND agent_alias = ?',
        sessionKey,
        alias,
      )?.m;
      const epoch = Math.max(cur.epoch, Number(maxConv ?? -1)) + 1;
      this.db.run(
        `UPDATE session_agents SET epoch = ?, runtime_session_id = ?, usage_totals = '{}', last_turn_at = NULL, last_turn_ms = NULL
         WHERE session_key = ? AND agent_alias = ?`,
        epoch,
        runtimeSessionIdOf(sessionKey, alias, epoch),
        sessionKey,
        alias,
      );
      return this.agentSession(sessionKey, alias);
    });
  }

  /** /agent: switch the currently selected agent; returns that agent's current conversation and whether it has been used here before */
  switchAgent(sessionKey: string, alias: string): { agent: AgentSession; resumed: boolean } {
    return this.db.tx(() => {
      const prev = this.peekAgentSession(sessionKey, alias);
      this.db.run('UPDATE sessions SET agent_alias = ? WHERE session_key = ?', alias, sessionKey);
      const agent = this.agentSession(sessionKey, alias);
      return { agent, resumed: !!prev && prev.usage.turns > 0 };
    });
  }

  /** /resume: recent conversations of this agent at this conversation location (including the current one), newest last turn first */
  listConversations(sessionKey: string, alias: string, limit = 10, now = Date.now()): ConversationInfo[] {
    return this.db
      .all<{ epoch: number; title: string | null; started_at: number; last_turn_at: number; usage_totals: string }>(
        `SELECT epoch, title, started_at, last_turn_at, usage_totals FROM conversations
         WHERE session_key = ? AND agent_alias = ? AND last_turn_at >= ? ORDER BY last_turn_at DESC LIMIT ?`,
        sessionKey,
        alias,
        now - CONVERSATION_RETENTION_MS,
        limit,
      )
      .map((r) => ({
        epoch: Number(r.epoch),
        title: r.title,
        startedAt: Number(r.started_at),
        lastTurnAt: Number(r.last_turn_at),
        turns: parseJson<Partial<UsageTotals>>(r.usage_totals, {}).turns ?? 0,
      }));
  }

  /** /resume <number>: switch that agent's current conversation back to an old epoch, and replace the usage with that conversation's */
  resumeConversation(sessionKey: string, alias: string, epoch: number): AgentSession | undefined {
    return this.db.tx(() => {
      const c = this.db.get<{ usage_totals: string; last_turn_at: number }>(
        'SELECT usage_totals, last_turn_at FROM conversations WHERE session_key = ? AND agent_alias = ? AND epoch = ?',
        sessionKey,
        alias,
        epoch,
      );
      if (!c) return undefined;
      this.agentSession(sessionKey, alias);
      this.db.run(
        `UPDATE session_agents SET epoch = ?, runtime_session_id = ?, usage_totals = ?, last_turn_at = ?, last_turn_ms = NULL
         WHERE session_key = ? AND agent_alias = ?`,
        epoch,
        runtimeSessionIdOf(sessionKey, alias, epoch),
        c.usage_totals,
        c.last_turn_at,
        sessionKey,
        alias,
      );
      return this.agentSession(sessionKey, alias);
    });
  }

  /** Periodically clean up conversation records past the retention period */
  purgeConversations(now = Date.now()): number {
    return this.db.run('DELETE FROM conversations WHERE last_turn_at < ?', now - CONVERSATION_RETENTION_MS).changes;
  }

  setLastPrompt(sessionKey: string, p: StoredPrompt | null): void {
    this.db.run('UPDATE sessions SET last_prompt = ? WHERE session_key = ?', p ? JSON.stringify(p) : null, sessionKey);
  }

  /** A turn ends: write turns and add the usage to the agent's current conversation (in one transaction) */
  finishTurn(t: TurnRecord): UsageTotals {
    return this.db.tx(() => {
      this.db.run(
        `INSERT OR REPLACE INTO turns(turn_id, session_key, agent_alias, started_at, ended_at, first_token_ms, input_tokens, output_tokens,
           cache_read, cache_write, model, result, error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        t.turnId,
        t.sessionKey,
        t.agentAlias,
        t.startedAt,
        t.endedAt,
        t.firstTokenMs,
        t.inputTokens,
        t.outputTokens,
        t.cacheRead,
        t.cacheWrite,
        t.model,
        t.result,
        t.errorCode,
      );
      const a = this.agentSession(t.sessionKey, t.agentAlias);
      const u = { ...a.usage };
      u.inputTokens += t.inputTokens;
      u.outputTokens += t.outputTokens;
      u.cacheReadTokens += t.cacheRead;
      u.cacheWriteTokens += t.cacheWrite;
      u.turns += 1;
      this.db.run(
        'UPDATE session_agents SET usage_totals = ?, last_turn_at = ?, last_turn_ms = ? WHERE session_key = ? AND agent_alias = ?',
        JSON.stringify(u),
        t.endedAt,
        t.endedAt - t.startedAt,
        t.sessionKey,
        t.agentAlias,
      );
      this.db.run('UPDATE sessions SET last_turn_at = ? WHERE session_key = ?', t.endedAt, t.sessionKey);
      // Conversation list (design 8.1): create the record on the first turn (with a title), and update the time and usage afterwards
      this.db.run(
        `INSERT OR IGNORE INTO conversations(session_key, agent_alias, epoch, title, started_at, last_turn_at, usage_totals)
         VALUES (?, ?, ?, ?, ?, ?, '{}')`,
        t.sessionKey,
        t.agentAlias,
        a.epoch,
        t.title || null,
        t.startedAt,
        t.endedAt,
      );
      this.db.run(
        'UPDATE conversations SET last_turn_at = ?, usage_totals = ? WHERE session_key = ? AND agent_alias = ? AND epoch = ?',
        t.endedAt,
        JSON.stringify(u),
        t.sessionKey,
        t.agentAlias,
        a.epoch,
      );
      return u;
    });
  }
}
