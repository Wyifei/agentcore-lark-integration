// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from 'vitest';
import { readSse } from '../src/agentcore/sse.ts';
import { normalize, type AgentEvent } from '../src/agentcore/events.ts';
import { invokeRuntime, invocationUrl, TurnError } from '../src/agentcore/invoke.ts';

async function* chunks(...parts: string[]) {
  const enc = new TextEncoder();
  for (const p of parts) yield enc.encode(p);
}
async function collect<T>(g: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}

describe('readSse', () => {
  it('跨 chunk 半行、CRLF、注释、多行 data', async () => {
    const r = await collect(readSse(chunks('data: {"a"', ':1}\r\n\r\n: ping\n\ndata: x\ndata: y\n\n', 'data: tail')));
    expect(r).toEqual(['{"a":1}', 'x\ny', 'tail']);
  });
  it('多字节字符被切开', async () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    async function* split() {
      yield bytes.slice(0, 7);
      yield bytes.slice(7);
    }
    expect(await collect(readSse(split()))).toEqual(['你好']);
  });
});

describe('normalize', () => {
  const n = (v: unknown) => normalize(typeof v === 'string' ? v : JSON.stringify(v)).events;
  it('第一层', () => {
    expect(n({ type: 'text', delta: 'hi' })).toEqual([{ type: 'text', delta: 'hi' }]);
    expect(n({ type: 'tool_end', id: 't', status: 'error', summary: 's' })[0]).toMatchObject({ status: 'error' });
    expect(n({ type: 'usage', inputTokens: 3, outputTokens: 4 })[0]).toMatchObject({ inputTokens: 3, cacheReadTokens: 0 });
    expect(n({ type: 'done' })).toEqual([{ type: 'done' }]);
    const it = n({ type: 'interrupt', id: 'v1:x', title: 't', options: [1, { label: '确认', value: 'yes' }, ...Array(6).fill({ label: 'x', value: 'x' })] })[0];
    expect(it).toMatchObject({ type: 'interrupt', id: 'v1:x', detail: '' });
    expect((it as { options: unknown[] }).options).toHaveLength(5);
    expect(n({ type: 'interrupt', title: 'no id' })).toEqual([]);
  });
  it('第二层 Strands 原始事件', () => {
    expect(n({ event: { contentBlockDelta: { delta: { text: 'a' } } } })).toEqual([{ type: 'text', delta: 'a' }]);
    expect(n({ event: { contentBlockDelta: { delta: { reasoningContent: { text: 'r' } } } } })).toEqual([
      { type: 'reasoning', delta: 'r' },
    ]);
    expect(n({ event: { contentBlockStart: { start: { toolUse: { toolUseId: 't1', name: 'search' } } } } })).toEqual([
      { type: 'tool_start', id: 't1', name: 'search' },
    ]);
    expect(
      n({ message: { role: 'user', content: [{ toolResult: { toolUseId: 't1', status: 'success', content: [{ text: '\nline1\nline2' }] } }] } }),
    ).toEqual([{ type: 'tool_end', id: 't1', status: 'success', summary: 'line1' }]);
    expect(n({ event: { metadata: { usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 5 } } } })[0]).toMatchObject({
      type: 'usage',
      cacheReadTokens: 5,
    });
  });
  it('回调式重复事件忽略；字符串当 text；Python repr 忽略', () => {
    expect(n({ data: 'a', delta: { text: 'a' } })).toEqual([]);
    expect(n(JSON.stringify('plain'))).toEqual([{ type: 'text', delta: 'plain' }]);
    expect(n('not json')).toEqual([{ type: 'text', delta: 'not json' }]);
    expect(n(JSON.stringify("{'data': 'x', 'agent': <Agent>}"))).toEqual([]);
  });
});

function sseResponse(lines: string[], status = 200, ctype = 'text/event-stream') {
  return new Response(lines.map((l) => `data: ${l}\n\n`).join(''), { status, headers: { 'content-type': ctype } });
}
const req = {
  runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/a-1',
  qualifier: 'DEFAULT',
  accessToken: 'tok',
  runtimeSessionId: 'fs-' + 'a'.repeat(40),
  payload: { prompt: 'p', actorId: 'a', conversationId: 'c', turnId: 't', chat: { chatType: 'p2p' as const, chatId: 'oc' } },
};

describe('invokeRuntime', () => {
  it('URL 编码 ARN', () => {
    expect(invocationUrl(req.runtimeArn, 'DEFAULT')).toBe(
      'https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aruntime%2Fa-1/invocations?qualifier=DEFAULT',
    );
  });
  it('请求头和事件', async () => {
    let seen: RequestInit | undefined;
    const f = (async (_u: string, init: RequestInit) => {
      seen = init;
      return sseResponse([JSON.stringify({ type: 'text', delta: 'x' }), JSON.stringify({ type: 'done' }), JSON.stringify({ type: 'text', delta: 'after' })]);
    }) as unknown as typeof fetch;
    const evs: AgentEvent[] = await collect(invokeRuntime(req, f));
    expect(evs).toEqual([{ type: 'text', delta: 'x' }, { type: 'done' }]);
    const h = seen!.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe(req.runtimeSessionId);
  });
  it('没有 done 的流正常结束也算成功', async () => {
    const f = (async () => sseResponse([JSON.stringify('hi')])) as unknown as typeof fetch;
    expect(await collect(invokeRuntime(req, f))).toEqual([{ type: 'text', delta: 'hi' }, { type: 'done' }]);
  });
  it('error 事件 → AGENT_ERROR；403 → FORBIDDEN_403', async () => {
    const f1 = (async () => sseResponse([JSON.stringify({ type: 'error', message: 'boom' })])) as unknown as typeof fetch;
    await expect(collect(invokeRuntime(req, f1))).rejects.toMatchObject({ code: 'AGENT_ERROR' });
    const f2 = (async () => new Response('{"message":"x"}', { status: 403 })) as unknown as typeof fetch;
    await expect(collect(invokeRuntime(req, f2))).rejects.toBeInstanceOf(TurnError);
    await expect(collect(invokeRuntime(req, f2))).rejects.toMatchObject({ code: 'FORBIDDEN_403' });
  });
  it('非流式 JSON 响应', async () => {
    const f = (async () => new Response('{"result":"ok"}', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    expect(await collect(invokeRuntime(req, f))).toEqual([{ type: 'text', delta: 'ok' }, { type: 'done' }]);
  });
  it('abort → TIMEOUT', async () => {
    const ctrl = new AbortController();
    const f = (async (_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const p = collect(invokeRuntime({ ...req, signal: ctrl.signal }, f));
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
