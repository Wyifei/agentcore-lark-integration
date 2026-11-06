// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/** Rendering state of one reply: driven by AgentEvent, and card building only reads it. */
import type { AgentEvent } from '../agentcore/events.ts';
import type { UsageTotals } from '../session/store.ts';

export type TurnPhase = 'queued' | 'thinking' | 'answering' | 'done' | 'awaiting' | 'error' | 'timeout' | 'interrupted';

export interface ToolCall {
  id: string;
  name: string;
  inputPreview?: string;
  status: 'running' | 'success' | 'error';
  summary?: string;
}

export interface TurnState {
  phase: TurnPhase;
  startedAt: number;
  endedAt?: number;
  answer: string;
  reasoning: string;
  tools: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string };
  sessionTotals?: UsageTotals;
  errorCode?: string;
  queuePosition?: number;
  /** "View trace" link; the button is not shown without it */
  traceUrl?: string;
  /** Values needed by the callback of the Regenerate button */
  retryValue?: Record<string, string>;
  /** The body is too long and the full content is sent as a separate file */
  truncated?: boolean;
  /** Number of files attached in this turn (shown on the card's status line) */
  attachments?: number;
  /** The agent asks for human confirmation (design 6.5) */
  interrupt?: { id: string; title: string; detail: string; options: { label: string; value: string }[] };
  /** Value of each option button's callback (generated in turn) */
  interruptValues?: Record<string, string>[];
  /** Note shown when this turn is a resume call, for example "Continue: selected Confirm" */
  resumeNote?: string;
}

export function newTurnState(now = Date.now()): TurnState {
  return {
    phase: 'thinking',
    startedAt: now,
    answer: '',
    reasoning: '',
    tools: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function preview(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  let s: string;
  if (typeof input === 'string') s = input;
  else if (typeof input === 'object') {
    const vals = Object.values(input as Record<string, unknown>).filter((v) => typeof v === 'string' || typeof v === 'number');
    s = vals.length ? String(vals[0]) : JSON.stringify(input);
  } else s = String(input);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}

/** Apply one event; returns whether there is a visible change. */
export function applyEvent(st: TurnState, ev: AgentEvent): boolean {
  switch (ev.type) {
    case 'text':
      if (!ev.delta) return false;
      st.answer += ev.delta;
      st.phase = 'answering';
      return true;
    case 'reasoning':
      if (!ev.delta) return false;
      st.reasoning += ev.delta;
      return true;
    case 'tool_start': {
      const existing = ev.id ? st.tools.find((t) => t.id === ev.id) : undefined;
      if (existing) {
        if (ev.input !== undefined) existing.inputPreview = preview(ev.input);
        return true;
      }
      st.tools.push({ id: ev.id, name: ev.name, inputPreview: preview(ev.input), status: 'running' });
      return true;
    }
    case 'tool_end': {
      const t = st.tools.find((x) => x.id === ev.id) ?? [...st.tools].reverse().find((x) => x.status === 'running');
      if (!t) {
        st.tools.push({ id: ev.id, name: 'tool', status: ev.status, summary: ev.summary });
      } else {
        t.status = ev.status;
        t.summary = ev.summary;
      }
      return true;
    }
    case 'usage':
      st.usage.inputTokens += ev.inputTokens;
      st.usage.outputTokens += ev.outputTokens;
      st.usage.cacheReadTokens += ev.cacheReadTokens;
      st.usage.cacheWriteTokens += ev.cacheWriteTokens;
      if (ev.model) st.usage.model = ev.model;
      return true;
    case 'interrupt':
      if (!st.interrupt) st.interrupt = { id: ev.id, title: ev.title, detail: ev.detail, options: ev.options };
      return true;
    case 'done':
    case 'error':
      return false;
  }
}
