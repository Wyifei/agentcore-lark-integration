// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from 'vitest';
import { anchorOf, runtimeSessionIdOf, sessionKeyOf } from '../src/session/keys.ts';
import { SessionQueues, ShutdownAbort, type Job } from '../src/session/queue.ts';
import { SessionStore, type TurnRecord } from '../src/session/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/sqlite.ts';
import { SeenEvents } from '../src/store/seen-events.ts';

describe('keys', () => {
  it('锚点：thread_id 优先', () => {
    expect(anchorOf('oc_1', 'omt_1')).toBe('omt_1');
    expect(anchorOf('oc_1', undefined)).toBe('oc_1');
  });
  it('runtimeSessionId：43 字符、稳定；epoch 或别名变化得到新 ID', () => {
    const k = sessionKeyOf('cli_a', 'oc_1', 'feishu:t:on_1');
    const a = runtimeSessionIdOf(k, 'default', 0);
    expect(a).toMatch(/^fs-[0-9a-f]{40}$/);
    expect(runtimeSessionIdOf(k, 'default', 0)).toBe(a);
    expect(runtimeSessionIdOf(k, 'default', 1)).not.toBe(a);
    expect(runtimeSessionIdOf(k, 'raw', 0)).not.toBe(a);
  });
});

const turn = (o: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: Math.random().toString(36), sessionKey: 'k', agentAlias: 'default', startedAt: 1, endedAt: 11, firstTokenMs: 3,
  inputTokens: 5, outputTokens: 7, cacheRead: 0, cacheWrite: 0, model: null, result: 'success', errorCode: null, ...o,
});

describe('SessionStore', () => {
  const init = { sessionKey: 'k', appId: 'cli', chatId: 'oc', threadId: null, userKey: 'u' };

  it('每个智能体各自的对话：用量分开累计，/new 只重置当前智能体', () => {
    const s = new SessionStore(openDb(':memory:'));
    s.getOrCreate(init);
    const d0 = s.agentSession('k', 'default');
    expect(d0.epoch).toBe(0);
    s.finishTurn(turn());
    expect(s.finishTurn(turn()).inputTokens).toBe(10);
    s.finishTurn(turn({ agentAlias: 'raw' }));
    expect(s.agentSession('k', 'raw').usage.turns).toBe(1);
    const d1 = s.bumpEpoch('k', 'default');
    expect([d1.epoch, d1.usage.turns]).toEqual([1, 0]);
    expect(d1.runtimeSessionId).not.toBe(d0.runtimeSessionId);
    expect(s.agentSession('k', 'raw').epoch).toBe(0); // Not affected
  });

  it('switchAgent：切回时接着上次的对话', () => {
    const s = new SessionStore(openDb(':memory:'));
    s.getOrCreate(init);
    const d = s.agentSession('k', 'default');
    s.finishTurn(turn());
    expect(s.switchAgent('k', 'raw').resumed).toBe(false);
    expect(s.get('k')!.agentAlias).toBe('raw');
    const back = s.switchAgent('k', 'default');
    expect(back.resumed).toBe(true);
    expect(back.agent.runtimeSessionId).toBe(d.runtimeSessionId);
  });

  it('同一别名改绑到另一个 runtime：自动开始新对话', () => {
    const s = new SessionStore(openDb(':memory:'));
    s.getOrCreate(init);
    const a = s.agentSession('k', 'default', 'arn:1');
    expect(s.agentSession('k', 'default', 'arn:1').runtimeSessionId).toBe(a.runtimeSessionId);
    const b = s.agentSession('k', 'default', 'arn:2');
    expect(b.epoch).toBe(1);
    expect(b.runtimeSessionId).not.toBe(a.runtimeSessionId);
  });

  it('last_prompt', () => {
    const s = new SessionStore(openDb(':memory:'));
    s.getOrCreate(init);
    s.setLastPrompt('k', { text: 'hi', images: [] });
    expect(s.get('k')!.lastPrompt).toEqual({ text: 'hi', images: [] });
  });

  it('从 v1 表结构迁移：保留 last_prompt 和别名', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'afb-mig-')), 'data.db');
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE sessions (session_key TEXT PRIMARY KEY, app_id TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id TEXT,
      user_key TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, agent_alias TEXT, runtime_session_id TEXT NOT NULL,
      usage_totals TEXT NOT NULL DEFAULT '{}', last_prompt TEXT, last_turn_at INTEGER, last_turn_ms INTEGER);
      CREATE TABLE seen_events (event_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      first_token_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
      model TEXT, result TEXT, error_code TEXT);
      PRAGMA user_version = 1;
      INSERT INTO sessions VALUES ('k','cli','oc',NULL,'u',3,'raw','fs-old','{}','{"text":"x","images":[]}',5,6);`);
    raw.close();
    const s = new SessionStore(openDb(path));
    expect(s.get('k')).toMatchObject({ agentAlias: 'raw', lastPrompt: { text: 'x', images: [] } });
    expect(s.agentSession('k', 'raw').epoch).toBe(0);
    s.finishTurn(turn({ agentAlias: 'raw' }));
  });
});

describe('SeenEvents', () => {
  it('判重和清理', () => {
    let now = 0;
    const s = new SeenEvents(openDb(':memory:'), () => now);
    expect(s.markFirstSeen('e1')).toBe(true);
    expect(s.markFirstSeen('e1')).toBe(false);
    now = 25 * 3600 * 1000;
    expect(s.purge()).toBe(1);
    expect(s.markFirstSeen('e1')).toBe(true);
  });
});

function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

describe('SessionQueues', () => {
  it('串行、排队位置、上限', async () => {
    const q = new SessionQueues(2);
    const order: number[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const positions: number[][] = [[], [], []];
    const job = (i: number): Job => ({
      run: async () => {
        order.push(i);
        await gates[i]!.p;
      },
      onQueued: (p) => void positions[i]!.push(p),
    });
    expect(q.enqueue('k', job(0))).toEqual({ status: 'started' });
    expect(q.enqueue('k', job(1))).toEqual({ status: 'queued', position: 1 });
    expect(q.enqueue('k', job(2))).toEqual({ status: 'queued', position: 2 });
    expect(q.enqueue('k', job(0))).toEqual({ status: 'full' });
    expect(q.enqueue('other', { run: async () => {} })).toEqual({ status: 'started' });
    gates[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([0, 1]);
    expect(positions[2]).toEqual([2, 1]);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([0, 1, 2]);
  });

  it('dropPending 丢弃排队消息', async () => {
    const q = new SessionQueues();
    const g = deferred();
    const dropped: string[] = [];
    q.enqueue('k', { run: () => g.p });
    q.enqueue('k', { run: async () => {}, onDropped: (r) => void dropped.push(r) });
    expect(q.dropPending('k')).toBe(1);
    expect(dropped).toEqual(['new_session']);
    g.resolve();
  });

  it('停机：排队的标记 shutdown，超时的被 abort', async () => {
    const q = new SessionQueues();
    let abortReason: unknown;
    const dropped: string[] = [];
    q.enqueue('k', {
      run: (signal) =>
        new Promise<void>((r) =>
          signal.addEventListener('abort', () => {
            abortReason = signal.reason;
            r();
          }),
        ),
    });
    q.enqueue('k', { run: async () => {}, onDropped: (r) => void dropped.push(r) });
    await q.shutdown(20);
    expect(dropped).toEqual(['shutdown']);
    expect(abortReason).toBeInstanceOf(ShutdownAbort);
    expect(q.enqueue('k', { run: async () => {} })).toEqual({ status: 'closed' });
  });
});

import { usageStats, usageMarkdown, purgeTurns, textTable, displayWidth } from '../src/store/usage.ts';
describe('usage', () => {
  it('按智能体汇总、按天列出、清理 90 天前', () => {
    const db = openDb(':memory:');
    const s = new SessionStore(db);
    const day = Date.UTC(2026, 10, 5, 3);
    const cases: [string, string, TurnRecord['result'], number][] = [
      ['cli_a|oc|u1', 'default', 'success', 10], ['cli_a|oc|u2', 'default', 'failure', 5], ['cli_a|oc|u1', 'raw', 'success', 1], ['cli_b|oc|u9', 'default', 'success', 7]];
    for (const [sk, al, res, it] of cases) {
      s.getOrCreate({ sessionKey: sk, appId: sk.split('|')[0]!, chatId: 'oc', threadId: null, userKey: sk.split('|')[2]! });
      s.finishTurn(turn({ sessionKey: sk, agentAlias: al, result: res, inputTokens: it, startedAt: day, endedAt: day + 2000, firstTokenMs: 500 }));
    }
    const u = usageStats(db, { appId: 'cli_a', sinceMs: day - 1 });
    const d = u.agents.find((a) => a.alias === 'default')!;
    expect([d.turns, d.success, d.failure, d.users, d.inputTokens, d.avgMs, d.medianFirstTokenMs]).toEqual([2, 1, 1, 2, 15, 2000, 500]);
    expect(u.days).toEqual([{ day: '2026-11-05', turns: 3, tokens: 37 }]);
    expect(usageMarkdown(u, 7, String)).toContain('| raw | 1 |');
    expect(purgeTurns(db, day + 91 * 86_400_000)).toBe(4);
  });
});

describe('textTable', () => {
  it('中文按两格宽对齐，数字列右对齐', () => {
    expect(displayWidth('智能体ab')).toBe(8);
    const t = textTable(['智能体', '轮数'], [['default', '7'], ['旧版', '19']], [false, true]).split('\n');
    expect(t).toEqual(['智能体   轮数', '-------  ----', 'default     7', '旧版       19']);
  });
});
