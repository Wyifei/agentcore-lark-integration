// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/** Usage statistics (design 8.2): only summarizes numbers in the turns table, with no message content. */
import type { Db } from './sqlite.ts';

export const TURNS_RETENTION_MS = 90 * 24 * 3600 * 1000;

export interface AgentUsage {
  appId: string;
  alias: string;
  turns: number;
  success: number;
  failure: number;
  timeout: number;
  users: number;
  inputTokens: number;
  outputTokens: number;
  avgMs: number;
  medianFirstTokenMs: number | null;
}

export interface DayUsage {
  day: string;
  turns: number;
  tokens: number;
}

interface Row {
  session_key: string;
  agent_alias: string | null;
  started_at: number;
  ended_at: number | null;
  first_token_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  result: string | null;
}

export function usageStats(db: Db, opts: { appId?: string; sinceMs: number; timeZone?: string }): { agents: AgentUsage[]; days: DayUsage[] } {
  const rows = db.all<Row>(
    `SELECT session_key, agent_alias, started_at, ended_at, first_token_ms, input_tokens, output_tokens, result
     FROM turns WHERE started_at >= ? ${opts.appId ? 'AND session_key LIKE ?' : ''}`,
    opts.sinceMs,
    ...(opts.appId ? [`${opts.appId}|%`] : []),
  );
  const agents = new Map<string, AgentUsage & { _users: Set<string>; _ms: number[]; _ft: number[] }>();
  const days = new Map<string, DayUsage>();
  const dayFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: opts.timeZone ?? 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  for (const r of rows) {
    const [appId = '', , userKey = ''] = r.session_key.split('|');
    const alias = r.agent_alias ?? '(0.2.0 之前)';
    const k = `${appId}\n${alias}`;
    let a = agents.get(k);
    if (!a) {
      a = { appId, alias, turns: 0, success: 0, failure: 0, timeout: 0, users: 0, inputTokens: 0, outputTokens: 0, avgMs: 0, medianFirstTokenMs: null, _users: new Set(), _ms: [], _ft: [] };
      agents.set(k, a);
    }
    a.turns++;
    if (r.result === 'success') a.success++;
    else if (r.result === 'timeout') a.timeout++;
    else a.failure++;
    a._users.add(userKey);
    a.inputTokens += Number(r.input_tokens ?? 0);
    a.outputTokens += Number(r.output_tokens ?? 0);
    if (r.ended_at) a._ms.push(Number(r.ended_at) - Number(r.started_at));
    if (r.first_token_ms !== null) a._ft.push(Number(r.first_token_ms));
    const day = dayFmt.format(new Date(Number(r.started_at)));
    const d = days.get(day) ?? { day, turns: 0, tokens: 0 };
    d.turns++;
    d.tokens += Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0);
    days.set(day, d);
  }
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)]!;
  };
  return {
    agents: [...agents.values()].map(({ _users, _ms, _ft, ...a }) => ({
      ...a,
      users: _users.size,
      avgMs: _ms.length ? Math.round(_ms.reduce((x, y) => x + y, 0) / _ms.length) : 0,
      medianFirstTokenMs: median(_ft),
    })),
    days: [...days.values()].sort((x, y) => x.day.localeCompare(y.day)),
  };
}

export function purgeTurns(db: Db, now = Date.now()): number {
  return db.run('DELETE FROM turns WHERE started_at < ?', now - TURNS_RETENTION_MS).changes;
}

/** Render as markdown (shared by Feishu cards and the CLI) */
export function usageMarkdown(u: { agents: AgentUsage[]; days: DayUsage[] }, days: number, fmtTokens: (n: number) => string): string {
  if (!u.agents.length) return `最近 ${days} 天没有对话。`;
  const lines = [`最近 ${days} 天：`, '', '| 智能体 | 轮数 | 成功/失败/超时 | 用户 | 输入/输出 token | 平均耗时 | 首字中位数 |', '|---|---|---|---|---|---|---|'];
  for (const a of u.agents) {
    lines.push(
      `| ${a.alias} | ${a.turns} | ${a.success}/${a.failure}/${a.timeout} | ${a.users} | ${fmtTokens(a.inputTokens)}/${fmtTokens(a.outputTokens)} | ${(a.avgMs / 1000).toFixed(1)}s | ${a.medianFirstTokenMs === null ? '-' : `${(a.medianFirstTokenMs / 1000).toFixed(1)}s`} |`,
    );
  }
  lines.push('', '| 日期 | 轮数 | token |', '|---|---|---|');
  for (const d of u.days) lines.push(`| ${d.day} | ${d.turns} | ${fmtTokens(d.tokens)} |`);
  return lines.join('\n');
}

/** Terminal display width: full-width characters such as CJK count as 2 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ? 2 : 1;
  }
  return w;
}

/** Text table aligned by column (numeric columns right-aligned) */
export function textTable(head: string[], rows: string[][], rightAlign: boolean[] = []): string {
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const pad = (v: string, i: number) => {
    const sp = ' '.repeat(widths[i]! - displayWidth(v));
    return rightAlign[i] ? sp + v : v + sp;
  };
  const line = (cells: string[]) => cells.map(pad).join('  ').trimEnd();
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** Usage table for the terminal (CLI usage) */
export function usageText(u: { agents: AgentUsage[]; days: DayUsage[] }, days: number, fmtTokens: (n: number) => string): string {
  if (!u.agents.length) return `最近 ${days} 天没有对话。`;
  const sec = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`);
  const t1 = textTable(
    ['智能体', '轮数', '成功', '失败', '超时', '用户', '输入', '输出', '平均耗时', '首字中位数'],
    u.agents.map((a) => [a.alias, String(a.turns), String(a.success), String(a.failure), String(a.timeout), String(a.users),
      fmtTokens(a.inputTokens), fmtTokens(a.outputTokens), sec(a.avgMs), sec(a.medianFirstTokenMs)]),
    [false, true, true, true, true, true, true, true, true, true],
  );
  const t2 = textTable(['日期', '轮数', 'token'], u.days.map((d) => [d.day, String(d.turns), fmtTokens(d.tokens)]), [false, true, true]);
  return `最近 ${days} 天：\n\n${t1}\n\n${t2}`;
}
