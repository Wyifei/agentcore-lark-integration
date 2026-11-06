// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Card 2.0 card building (design 7.1, 7.3, 7.5).
 *
 * Two layouts:
 * - Streaming layout: only markdown elements (status / tools / answer); while streaming only the text of these elements is updated.
 *   In streaming mode CardKit restricts interactive components such as collapsible panels and buttons, so those appear only in the final layout.
 * - Final layout: title (state + duration), reasoning panel, tool list, body, footer, buttons; replaced by one card.update
 *   that also turns off streaming_mode.
 */
import { prepareCardMarkdown } from './markdown.ts';
import type { TurnState, ToolCall } from './turn-state.ts';

export const ELEMENT = { status: 'status', tools: 'tools', answer: 'answer' } as const;

/** A whole card request is at most 30,000 bytes; leave a margin */
export const CARD_MAX_BYTES = 28_000;
/** A single write of the body is at most 30,000 characters */
export const ANSWER_MAX_CHARS = 30_000;
/** Byte budget of the body while streaming (the tool list, status, and so on take the rest) */
export const STREAM_ANSWER_MAX_BYTES = 22_000;
export const TRUNCATION_NOTE = '\n\n…（内容较长，完整回复见下方文件）';

export const STREAMING_CONFIG = {
  print_frequency_ms: { default: 70 },
  print_step: { default: 1 },
  print_strategy: 'fast',
};

type Json = Record<string, unknown>;

export function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Truncate by UTF-8 bytes (without cutting a multi-byte character) */
export function truncateBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  let t = buf.toString('utf8');
  if (t.endsWith('�')) t = t.slice(0, -1);
  return t;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

const PHASE: Record<TurnState['phase'], { title: string; template: string }> = {
  queued: { title: '排队中', template: 'grey' },
  thinking: { title: '思考中', template: 'wathet' },
  answering: { title: '回复中', template: 'blue' },
  done: { title: '已完成', template: 'green' },
  awaiting: { title: '等待确认', template: 'orange' },
  error: { title: '出错', template: 'red' },
  timeout: { title: '超时', template: 'orange' },
  interrupted: { title: '服务重启，已中断', template: 'orange' },
};

export function headerTitle(st: TurnState, now = Date.now()): string {
  const p = PHASE[st.phase];
  if (st.phase === 'queued') return `${p.title}（第 ${st.queuePosition ?? 1} 位）`;
  const elapsed = fmtElapsed((st.endedAt ?? now) - st.startedAt);
  if (st.phase === 'error') return `${p.title} · ${st.errorCode ?? 'UNKNOWN'} · ${elapsed}`;
  return `${p.title} · ${elapsed}`;
}

function header(title: string, template: string): Json {
  return { title: { tag: 'plain_text', content: title }, template };
}

function md(elementId: string | undefined, content: string, extra: Json = {}): Json {
  return { tag: 'markdown', ...(elementId ? { element_id: elementId } : {}), content, ...extra };
}

const ICON: Record<ToolCall['status'], string> = { running: '⏳', success: '⏺', error: '❌' };

/** Escape Feishu card markdown, so user-supplied text cannot inject formatting, links, or tags such as <at> / <font> */
export function escapeMd(s: string): string {
  return s.replace(/([*_`[\]<>~|])/g, '\\$1');
}

export function toolsMarkdown(tools: ToolCall[], max = 20): string {
  if (!tools.length) return '';
  const shown = tools.length > max ? tools.slice(-max) : tools;
  const lines: string[] = [];
  if (tools.length > max) lines.push(`<font color='grey'>… 省略 ${tools.length - max} 个更早的工具调用</font>`);
  for (const t of shown) {
    lines.push(`${ICON[t.status]} **${escapeMd(t.name)}**${t.inputPreview ? `(${escapeMd(t.inputPreview)})` : ''}`);
    if (t.summary) lines.push(`<font color='grey'>└ ${escapeMd(t.summary)}</font>`);
  }
  return lines.join('\n');
}

/** Status line while streaming: when thinking, show the last short part of the reasoning */
export function statusMarkdown(st: TurnState): string {
  const pre = [st.resumeNote ? `▶ ${escapeMd(st.resumeNote)}` : '', st.attachments ? `📎 已附 ${st.attachments} 个文件` : '']
    .filter(Boolean)
    .join(' · ');
  return pre ? `<font color='grey'>${pre}</font> ` + statusCore(st) : statusCore(st);
}

function statusCore(st: TurnState): string {
  if (st.phase === 'thinking' && st.reasoning) {
    const tail = st.reasoning.slice(-120).replace(/\s+/g, ' ').trim();
    return `<font color='grey'>💭 ${escapeMd(tail)}</font>`;
  }
  if (st.phase === 'thinking' && !st.tools.length) return `<font color='grey'>思考中…</font>`;
  return '';
}

/** Body while streaming: keep the first part when over budget */
export function streamingAnswer(st: TurnState): string {
  let a = st.answer;
  if (byteLen(a) > STREAM_ANSWER_MAX_BYTES || a.length > ANSWER_MAX_CHARS) {
    a = truncateBytes(a, STREAM_ANSWER_MAX_BYTES).slice(0, ANSWER_MAX_CHARS - 100) + '\n\n…（内容较长，完整回复将在结束后以文件发送）';
  }
  return prepareCardMarkdown(a);
}

/** Streaming layout (used when sending the card; streaming_mode is turned on directly in config) */
export function buildStreamingCard(st: TurnState): Json {
  return {
    schema: '2.0',
    config: { streaming_mode: true, streaming_config: STREAMING_CONFIG, update_multi: true, summary: { content: '思考中…' } },
    header: header(headerTitle(st), PHASE[st.phase].template),
    body: {
      elements: [
        md(ELEMENT.status, statusMarkdown(st) || ' '),
        md(ELEMENT.tools, toolsMarkdown(st.tools) || ' '),
        md(ELEMENT.answer, streamingAnswer(st) || ' '),
      ],
    },
  };
}

export function footerMarkdown(st: TurnState): string {
  const u = st.usage;
  const parts: string[] = [];
  if (u.inputTokens || u.outputTokens) parts.push(`输入 ${fmtTokens(u.inputTokens)} · 输出 ${fmtTokens(u.outputTokens)}`);
  if (u.cacheReadTokens) parts.push(`缓存 ${fmtTokens(u.cacheReadTokens)}`);
  if (u.model) parts.push(escapeMd(u.model));
  if (st.sessionTotals && st.sessionTotals.turns > 0) {
    parts.push(`本会话 ${st.sessionTotals.turns} 轮 · ${fmtTokens(st.sessionTotals.inputTokens + st.sessionTotals.outputTokens)} tokens`);
  }
  return parts.length ? `<font color='grey'>${parts.join(' · ')}</font>` : '';
}

const ERROR_HINT: Record<string, string> = {
  AUTH_401: '认证失败，请稍后重试。',
  FORBIDDEN_403: '智能体拒绝了这次调用（可能是 runtime 的认证配置不包含本机器人），请联系管理员。',
  NOT_FOUND_404: '找不到智能体，请联系管理员检查绑定。',
  THROTTLED_429: '调用太频繁，请稍后再试。',
  RUNTIME_5XX: '智能体服务暂时不可用，请稍后再试。',
  RUNTIME_4XX: '调用智能体失败，请联系管理员。',
  AGENT_ERROR: '智能体处理出错。',
  STREAM_INTERRUPTED: '回复中断，请重试。',
  NETWORK: '网络错误，请稍后再试。',
  TIMEOUT: '本轮超时，已停止等待。',
  SHUTDOWN: '服务重启，本轮已中断，请重发。',
  IDENTITY: '无法为你签发访问凭证，请联系管理员。',
  FILE_TOO_LARGE: '文件太大：单个文件不超过 20 MB，一次合计不超过 50 MB，最多 5 个。',
};

export function errorHint(code: string | undefined): string {
  return ERROR_HINT[code ?? ''] ?? '处理失败，请稍后再试。';
}

function summaryOf(st: TurnState): string {
  if (st.phase === 'awaiting') return `等待确认：${st.interrupt?.title ?? ''}`.slice(0, 50);
  if (st.phase === 'done') {
    const s = st.answer.replace(/[#*`>\-|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (s || '已完成').slice(0, 50);
  }
  return headerTitle(st).slice(0, 50);
}

/** Final layout; answerOverride is used for length truncation */
export function buildFinalCard(st: TurnState, answerOverride?: string): Json {
  const elements: Json[] = [];
  // Note for resume calls / scheduled tasks (design 6.5, 8.3)
  if (st.resumeNote) elements.push(md('note', `<font color='grey'>▶ ${escapeMd(st.resumeNote)}</font>`, { text_size: 'notation' }));
  if (st.reasoning.trim()) {
    elements.push({
      tag: 'collapsible_panel',
      element_id: 'reasoning',
      expanded: false,
      header: { title: { tag: 'markdown', content: '💭 思考过程' }, icon_position: 'right', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' }, icon_expanded_angle: -180 },
      elements: [md(undefined, prepareCardMarkdown(truncateBytes(st.reasoning, 6_000)), { text_size: 'notation' })],
    });
  }
  const tools = toolsMarkdown(st.tools);
  if (tools) elements.push(md(ELEMENT.tools, tools));
  const answer = answerOverride ?? st.answer;
  if (answer.trim()) elements.push(md(ELEMENT.answer, prepareCardMarkdown(answer)));
  if (st.interrupt) {
    // Human confirmation (design 6.5): title, description, and option buttons
    elements.push(md('confirm', `**${escapeMd(st.interrupt.title)}**${st.interrupt.detail ? `\n<font color='grey'>${escapeMd(st.interrupt.detail)}</font>` : ''}`));
    const btns = st.interrupt.options.map((o, i) => ({
      tag: 'button',
      element_id: `btn_opt_${i}`,
      text: { tag: 'plain_text', content: o.label },
      type: i === 0 ? 'primary' : 'default',
      size: 'small',
      behaviors: [{ type: 'callback', value: st.interruptValues?.[i] ?? {} }],
    }));
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: '8px',
      columns: btns.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
    });
  }
  if (st.phase !== 'done' && st.phase !== 'awaiting') elements.push(md('err', `<font color='${st.phase === 'error' ? 'red' : 'orange'}'>${errorHint(st.errorCode ?? (st.phase === 'timeout' ? 'TIMEOUT' : st.phase === 'interrupted' ? 'SHUTDOWN' : undefined))}</font>`));
  const footer = footerMarkdown(st);
  if (footer) elements.push(md('footer', footer, { text_size: 'notation' }));
  const buttons: Json[] = [];
  if (st.retryValue) {
    buttons.push({
      tag: 'button',
      element_id: 'btn_retry',
      text: { tag: 'plain_text', content: '重新生成' },
      type: 'default',
      size: 'small',
      behaviors: [{ type: 'callback', value: st.retryValue }],
    });
  }
  if (st.traceUrl) {
    buttons.push({
      tag: 'button',
      element_id: 'btn_trace',
      text: { tag: 'plain_text', content: '查看 Trace' },
      type: 'default',
      size: 'small',
      behaviors: [{ type: 'open_url', default_url: st.traceUrl }],
    });
  }
  if (buttons.length) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: '8px',
      columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
    });
  }
  return {
    schema: '2.0',
    config: { streaming_mode: false, update_multi: true, summary: { content: summaryOf(st) } },
    header: header(headerTitle(st), PHASE[st.phase].template),
    body: { elements: elements.length ? elements : [md(undefined, ' ')] },
  };
}

/**
 * Final card + length control: when CARD_MAX_BYTES is exceeded, the body keeps the first part and points to the file.
 * Returns the card and whether it was truncated (when truncated the caller sends a .md file separately).
 */
export function buildFinalCardFitted(st: TurnState): { card: Json; truncated: boolean } {
  let card = buildFinalCard(st);
  if (byteLen(JSON.stringify(card)) <= CARD_MAX_BYTES && st.answer.length <= ANSWER_MAX_CHARS) return { card, truncated: false };
  const overhead = byteLen(JSON.stringify(buildFinalCard(st, ''))) + byteLen(TRUNCATION_NOTE) + 512;
  let budget = Math.max(1_000, CARD_MAX_BYTES - overhead);
  for (let i = 0; i < 8; i++) {
    const cut = truncateBytes(st.answer, budget).slice(0, ANSWER_MAX_CHARS - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
    card = buildFinalCard(st, cut);
    const size = byteLen(JSON.stringify(card));
    if (size <= CARD_MAX_BYTES) return { card, truncated: true };
    budget -= size - CARD_MAX_BYTES + 256; // Markdown adaptation and JSON escaping enlarge it
  }
  return { card: buildFinalCard(st, '（内容较长，完整回复见下方文件）'), truncated: true };
}

/** Simple cards for queued / notice messages */
export function buildNoticeCard(title: string, body: string, template = 'grey'): Json {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title.slice(0, 50) } },
    header: header(title, template),
    body: { elements: [md(undefined, body || ' ')] },
  };
}

export function buildQueuedCard(position: number): Json {
  return buildNoticeCard(`排队中（第 ${position} 位）`, '<font color=\'grey\'>上一条消息处理完后开始。</font>');
}
