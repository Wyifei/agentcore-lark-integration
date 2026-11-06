// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Internal events (the layer-1 contract of design 6.2) and normalization.
 *
 * Layer 1: the reference agent template outputs these types directly.
 * Layer 2: best-effort parsing of raw Strands events (the case where `stream_async()` events are yielded as they are).
 *
 * `usage` events are incremental: one per model call, and the consumer accumulates them.
 */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input?: unknown }
  | { type: 'tool_end'; id: string; status: 'success' | 'error'; summary?: string }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      model?: string;
    }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: string }
  | { type: 'interrupt'; id: string; name: string; title: string; detail: string; options: { label: string; value: string }[] };

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** First line of the tool result, at most 200 characters */
export function firstLine(s: string, max = 200): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function fromLayer1(o: Record<string, unknown>): AgentEvent[] | null {
  switch (o.type) {
    case 'text':
    case 'reasoning':
      return typeof o.delta === 'string' ? [{ type: o.type, delta: o.delta }] : [];
    case 'tool_start':
      return [{ type: 'tool_start', id: str(o.id) ?? '', name: str(o.name) ?? 'tool', input: o.input }];
    case 'tool_end':
      return [
        {
          type: 'tool_end',
          id: str(o.id) ?? '',
          status: o.status === 'error' ? 'error' : 'success',
          summary: str(o.summary),
        },
      ];
    case 'usage':
      return [
        {
          type: 'usage',
          inputTokens: num(o.inputTokens),
          outputTokens: num(o.outputTokens),
          cacheReadTokens: num(o.cacheReadTokens),
          cacheWriteTokens: num(o.cacheWriteTokens),
          model: str(o.model),
        },
      ];
    case 'done':
      return [{ type: 'done' }];
    case 'interrupt': {
      // Human confirmation (design 6.5): at most 5 options
      const id = str(o.id);
      if (!id) return [];
      const opts = (Array.isArray(o.options) ? o.options : [])
        .map((x) => obj(x))
        .filter((x): x is Record<string, unknown> => !!x && typeof x.label === 'string' && typeof x.value === 'string')
        .slice(0, 5)
        .map((x) => ({ label: (x.label as string).slice(0, 20), value: (x.value as string).slice(0, 64) }));
      return [
        {
          type: 'interrupt',
          id,
          name: str(o.name) ?? '',
          title: (str(o.title) ?? '需要确认').slice(0, 100),
          detail: (str(o.detail) ?? '').slice(0, 1000),
          options: opts.length ? opts : [{ label: '确认', value: 'yes' }, { label: '取消', value: 'no' }],
        },
      ];
    }
    case 'error':
      return [{ type: 'error', message: str(o.message) ?? 'agent error', code: str(o.code) }];
    default:
      return null;
  }
}

function fromStrandsRaw(o: Record<string, unknown>): AgentEvent[] {
  const ev = obj(o.event);
  if (ev) {
    const cbd = obj(obj(ev.contentBlockDelta)?.delta);
    if (cbd) {
      if (typeof cbd.text === 'string') return [{ type: 'text', delta: cbd.text }];
      const rc = obj(cbd.reasoningContent);
      if (rc && typeof rc.text === 'string') return [{ type: 'reasoning', delta: rc.text }];
      return [];
    }
    const tu = obj(obj(obj(ev.contentBlockStart)?.start)?.toolUse);
    if (tu) return [{ type: 'tool_start', id: str(tu.toolUseId) ?? '', name: str(tu.name) ?? 'tool' }];
    const usage = obj(obj(ev.metadata)?.usage);
    if (usage) {
      return [
        {
          type: 'usage',
          inputTokens: num(usage.inputTokens),
          outputTokens: num(usage.outputTokens),
          cacheReadTokens: num(usage.cacheReadInputTokens),
          cacheWriteTokens: num(usage.cacheWriteInputTokens),
        },
      ];
    }
    return [];
  }
  const msg = obj(o.message);
  if (msg && Array.isArray(msg.content)) {
    const out: AgentEvent[] = [];
    for (const block of msg.content) {
      const tr = obj(obj(block)?.toolResult);
      if (!tr) continue;
      let summary: string | undefined;
      if (Array.isArray(tr.content)) {
        const t = tr.content.map((c) => str(obj(c)?.text)).find((x) => x);
        if (t) summary = firstLine(t);
      }
      out.push({ type: 'tool_end', id: str(tr.toolUseId) ?? '', status: tr.status === 'error' ? 'error' : 'success', summary });
    }
    return out;
  }
  // Other Strands events (callback-style events such as {"data": ..., "delta": ...} duplicate event.contentBlockDelta,
  // and init_event_loop, start, result, and so on) are all ignored.
  return [];
}

/** A Python dict repr (the SDK falls back to str() when serialization fails); not shown as body text */
const PY_REPR = /^\{'[A-Za-z_]+':/;

/**
 * Normalize one SSE `data:` payload into zero or more internal events.
 * Returns `unknown: true` when nothing was recognized (the caller writes a debug log).
 */
export function normalize(payload: string): { events: AgentEvent[]; unknown: boolean } {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    // Not JSON: treat as plain text
    return PY_REPR.test(payload) ? { events: [], unknown: true } : { events: [{ type: 'text', delta: payload }], unknown: false };
  }
  if (typeof v === 'string') {
    // `yield "..."` or an event that cannot be serialized: treat as text
    return PY_REPR.test(v) ? { events: [], unknown: true } : { events: [{ type: 'text', delta: v }], unknown: false };
  }
  const o = obj(v);
  if (!o) return { events: [], unknown: true };
  if (typeof o.type === 'string') {
    const l1 = fromLayer1(o);
    if (l1) return { events: l1, unknown: false };
  }
  const raw = fromStrandsRaw(o);
  return { events: raw, unknown: raw.length === 0 && !('data' in o) && !('init_event_loop' in o) && !('start' in o) };
}
