// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalize, type AgentEvent } from '../src/agentcore/events.ts';

// Real SSE payloads recorded in testing (Tokyo region, reference template / raw Strands events yielded as they are)
function run(name: string): AgentEvent[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => normalize(l).events);
}
const counts = (evs: AgentEvent[]) => evs.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
const text = (evs: AgentEvent[]) => evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

describe('真实 SSE 样本', () => {
  it('第一层：参考模板', () => {
    const evs = run('sse-ref.jsonl');
    expect(counts(evs)).toMatchObject({ tool_start: 2, tool_end: 1, usage: 2, done: 1 });
    expect(text(evs)).toMatch(/北京时间/);
    expect(text(evs)).toMatch(/UTC/);
  });
  it('第二层：Strands 原始事件——正文不重复、Python repr 被丢弃、工具和用量都识别', () => {
    const evs = run('sse-raw.jsonl');
    const { text: nText, ...rest } = counts(evs);
    expect(nText).toBeGreaterThan(0);
    expect(rest).toEqual({ usage: 2, tool_start: 1, tool_end: 1 });
    const t = text(evs);
    expect(t).not.toMatch(/Agent object|AgentResult/);
    // Each segment appears only once (callback-style events and contentBlockDelta are not counted twice)
    expect(t.match(/北京时间/g)).toHaveLength(1);
  });
});
