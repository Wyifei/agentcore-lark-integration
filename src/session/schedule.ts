// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Scheduled tasks (design 8.3): time-rule parsing, next-run calculation, and reading and writing the schedules table.
 *
 * Time rules: `每天 HH:MM` / `daily HH:MM` (every day), `工作日 HH:MM` / `weekdays HH:MM` (weekdays), `每周一 HH:MM` / `every mon HH:MM` (weekly, 一 to 日 = Monday to Sunday),
 * `每 N 分钟` / `every N minutes` (N >= 10), `每 N 小时` / `every N hours`.
 * The time zone follows the bot configuration (Asia/Shanghai by default). Missed runs are not made up.
 */
import type { Db } from '../store/sqlite.ts';

export type Spec =
  | { kind: 'daily'; hh: number; mm: number }
  | { kind: 'weekdays'; hh: number; mm: number }
  | { kind: 'weekly'; dow: number; hh: number; mm: number } // dow: 0=Sunday … 6=Saturday
  | { kind: 'interval'; minutes: number };

export const MIN_INTERVAL_MINUTES = 10;
export const MAX_SCHEDULES_PER_BOT = 50;
const DOW: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const EN_DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class SpecError extends Error {
  override name = 'SpecError';
}

/** Parse the time rule from the beginning of the command arguments; returns the rule and the remaining message */
export function parseSpec(text: string): { spec: Spec; rest: string } {
  const t = text.trim();
  const hm = (h: string, m: string) => {
    const hh = Number(h);
    const mm = Number(m);
    if (hh > 23 || mm > 59) throw new SpecError('时间不对，例如 09:30');
    return { hh, mm };
  };
  let m = /^每天\s*(\d{1,2})[:：](\d{2})\s+([\s\S]+)$/.exec(t);
  if (m) return { spec: { kind: 'daily', ...hm(m[1]!, m[2]!) }, rest: m[3]!.trim() };
  m = /^工作日\s*(\d{1,2})[:：](\d{2})\s+([\s\S]+)$/.exec(t);
  if (m) return { spec: { kind: 'weekdays', ...hm(m[1]!, m[2]!) }, rest: m[3]!.trim() };
  m = /^每周([一二三四五六日天])\s*(\d{1,2})[:：](\d{2})\s+([\s\S]+)$/.exec(t);
  if (m) return { spec: { kind: 'weekly', dow: DOW[m[1]!]!, ...hm(m[2]!, m[3]!) }, rest: m[4]!.trim() };
  m = /^每\s*(\d+)\s*(分钟|小时)\s+([\s\S]+)$/.exec(t);
  if (m) return interval(Number(m[1]) * (m[2] === '小时' ? 60 : 1), m[3]!);
  // English keywords: daily HH:MM / weekdays HH:MM / every mon HH:MM / every N minutes|hours
  m = /^daily\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(t);
  if (m) return { spec: { kind: 'daily', ...hm(m[1]!, m[2]!) }, rest: m[3]!.trim() };
  m = /^weekdays\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(t);
  if (m) return { spec: { kind: 'weekdays', ...hm(m[1]!, m[2]!) }, rest: m[3]!.trim() };
  m = /^every\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(t);
  if (m) return { spec: { kind: 'weekly', dow: EN_DOW.indexOf(m[1]!.toLowerCase()), ...hm(m[2]!, m[3]!) }, rest: m[4]!.trim() };
  m = /^every\s+(\d+)\s*(minutes?|mins?|m|hours?|h)\s+([\s\S]+)$/i.exec(t);
  if (m) return interval(Number(m[1]) * (/^h/i.test(m[2]!) ? 60 : 1), m[3]!);
  throw new SpecError(
    '时间格式：每天 HH:MM / 工作日 HH:MM / 每周一 HH:MM / 每 N 分钟 / 每 N 小时，后面跟消息' +
      '（也支持 daily HH:MM / weekdays HH:MM / every mon HH:MM / every N minutes / every N hours）',
  );
}

function interval(minutes: number, rest: string): { spec: Spec; rest: string } {
  if (minutes < MIN_INTERVAL_MINUTES) throw new SpecError(`间隔至少 ${MIN_INTERVAL_MINUTES} 分钟`);
  return { spec: { kind: 'interval', minutes }, rest: rest.trim() };
}

export function describeSpec(s: Spec): string {
  const p = (n: number) => String(n).padStart(2, '0');
  switch (s.kind) {
    case 'daily':
      return `每天 ${p(s.hh)}:${p(s.mm)}`;
    case 'weekdays':
      return `工作日 ${p(s.hh)}:${p(s.mm)}`;
    case 'weekly':
      return `每周${'日一二三四五六'[s.dow]} ${p(s.hh)}:${p(s.mm)}`;
    case 'interval':
      return s.minutes % 60 === 0 ? `每 ${s.minutes / 60} 小时` : `每 ${s.minutes} 分钟`;
  }
}

/** Year, month, day, weekday, hour, and minute of a moment in a time zone */
function parts(ms: number, tz: string): { y: number; mo: number; d: number; dow: number; hh: number; mm: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    y: Number(o.year), mo: Number(o.month), d: Number(o.day),
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday!),
    hh: Number(o.hour) % 24, mm: Number(o.minute),
  };
}

/** Local time in a time zone → UTC milliseconds */
function zoned(y: number, mo: number, d: number, hh: number, mm: number, tz: string): number {
  let guess = Date.UTC(y, mo - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, tz);
    const diff = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm) - Date.UTC(y, mo - 1, d, hh, mm);
    guess -= diff;
  }
  return guess;
}

/** The next run time strictly later than fromMs */
export function nextRun(spec: Spec, fromMs: number, tz: string): number {
  if (spec.kind === 'interval') return fromMs + spec.minutes * 60_000;
  const today = parts(fromMs, tz);
  for (let i = 0; i < 8; i++) {
    const day = parts(fromMs + i * 86_400_000, tz);
    const at = zoned(day.y, day.mo, day.d, spec.hh, spec.mm, tz);
    if (at <= fromMs) continue;
    const ok =
      spec.kind === 'daily' ||
      (spec.kind === 'weekdays' && day.dow >= 1 && day.dow <= 5) ||
      (spec.kind === 'weekly' && day.dow === spec.dow);
    if (ok) return at;
  }
  throw new Error(`算不出下次执行时间（${JSON.stringify(spec)} from ${today.y}-${today.mo}-${today.d}）`);
}

export interface Schedule {
  id: number;
  appId: string;
  sessionKey: string;
  unionId: string;
  tenantKey: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId: string | null;
  /** Replying in a topic needs a message inside that topic */
  sourceMessageId: string;
  spec: Spec;
  prompt: string;
  nextRunAt: number;
  enabled: boolean;
  createdAt: number;
}

interface Row {
  id: number;
  app_id: string;
  session_key: string;
  union_id: string;
  tenant_key: string;
  chat_id: string;
  chat_type: string;
  thread_id: string | null;
  source_message_id: string;
  spec: string;
  prompt: string;
  next_run_at: number;
  enabled: number;
  created_at: number;
}

const fromRow = (r: Row): Schedule => ({
  id: Number(r.id),
  appId: r.app_id,
  sessionKey: r.session_key,
  unionId: r.union_id,
  tenantKey: r.tenant_key,
  chatId: r.chat_id,
  chatType: r.chat_type === 'p2p' ? 'p2p' : 'group',
  threadId: r.thread_id,
  sourceMessageId: r.source_message_id,
  spec: JSON.parse(r.spec) as Spec,
  prompt: r.prompt,
  nextRunAt: Number(r.next_run_at),
  enabled: Number(r.enabled) === 1,
  createdAt: Number(r.created_at),
});

export class ScheduleStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  add(s: Omit<Schedule, 'id' | 'enabled' | 'createdAt'>, now = Date.now()): Schedule {
    const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schedules WHERE app_id = ? AND enabled = 1', s.appId)!.n;
    if (Number(n) >= MAX_SCHEDULES_PER_BOT) throw new SpecError(`每个机器人最多 ${MAX_SCHEDULES_PER_BOT} 个定时任务`);
    this.db.run(
      `INSERT INTO schedules(app_id, session_key, union_id, tenant_key, chat_id, chat_type, thread_id, source_message_id, spec, prompt, next_run_at, enabled, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      s.appId, s.sessionKey, s.unionId, s.tenantKey, s.chatId, s.chatType, s.threadId, s.sourceMessageId,
      JSON.stringify(s.spec), s.prompt, s.nextRunAt, now,
    );
    const id = this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    return this.get(Number(id))!;
  }

  get(id: number): Schedule | undefined {
    const r = this.db.get<Row>('SELECT * FROM schedules WHERE id = ?', id);
    return r ? fromRow(r) : undefined;
  }

  /** Enabled tasks at this conversation location, by creation time */
  list(sessionKey: string): Schedule[] {
    return this.db.all<Row>('SELECT * FROM schedules WHERE session_key = ? AND enabled = 1 ORDER BY id', sessionKey).map(fromRow);
  }

  remove(id: number): void {
    this.db.run('DELETE FROM schedules WHERE id = ?', id);
  }

  due(now = Date.now()): Schedule[] {
    return this.db.all<Row>('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at', now).map(fromRow);
  }

  setNext(id: number, nextRunAt: number): void {
    this.db.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', nextRunAt, id);
  }

  disable(id: number): void {
    this.db.run('UPDATE schedules SET enabled = 0 WHERE id = ?', id);
  }
}
