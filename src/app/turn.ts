// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Run one chat turn (design 5.3, 6, 7):
 *   open the streaming card → download images → get a token → call the runtime → event-driven rendering → finish the card → write turns / usage_totals
 * Logs record only sessionKey, turnId, duration, tokens, and error code (design 11).
 */
import { randomUUID } from 'node:crypto';
import type { AgentBinding } from '../config/bots-store.ts';
import { regionFromRuntimeArn } from '../config/bots-store.ts';
import { invokeRuntime, TurnError, type FetchLike, type InvokePayload } from '../agentcore/invoke.ts';
import type { TokenProvider } from '../identity/token-provider.ts';
import type { LarkApi, ReplyTarget } from '../lark/api.ts';
import { MAX_IMAGE_BYTES } from '../lark/api.ts';
import { CardStream } from '../render/card-stream.ts';
import { applyEvent, newTurnState } from '../render/turn-state.ts';
import { ShutdownAbort } from '../session/queue.ts';
import { conversationTitle, type SessionStore, type StoredPrompt } from '../session/store.ts';
import { logger } from '../util/log.ts';

const log = logger('turn');

/** Validity period of confirmation buttons (design 6.5) */
export const CONFIRM_TTL_SEC = 24 * 3600;

export const MAX_IMAGES = 5;
export const MAX_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;
/** File limits (design 6.4): base64 inflates size by about 33%, and with images it still stays within the runtime's 100 MB request limit */
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_TOTAL_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html', json: 'application/json',
  xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', log: 'text/plain', py: 'text/x-python',
  js: 'text/javascript', ts: 'text/plain', java: 'text/plain', go: 'text/plain', sql: 'text/plain', sh: 'text/plain',
  zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
};

export function mimeOf(name: string, data: Buffer): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]!;
  if (data.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (data[0] === 0x50 && data[1] === 0x4b) return 'application/zip';
  return 'application/octet-stream';
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Download this turn's files; throw TurnError('FILE_TOO_LARGE') when over the limit, and do not call the agent */
async function loadFiles(api: LarkApi, prompt: StoredPrompt): Promise<NonNullable<InvokePayload['files']>> {
  const refs = prompt.files ?? [];
  if (refs.length > MAX_FILES) throw new TurnError('FILE_TOO_LARGE', 'too many files');
  const out: NonNullable<InvokePayload['files']> = [];
  let total = 0;
  for (const ref of refs) {
    let data: Buffer;
    try {
      data = await api.downloadFile(ref.messageId, ref.fileKey, Math.min(MAX_FILE_BYTES, MAX_FILES_TOTAL_BYTES - total));
    } catch (e) {
      if ((e as Error).name === 'FileTooLargeError') throw new TurnError('FILE_TOO_LARGE', 'file too large');
      throw e;
    }
    total += data.length;
    out.push({ name: ref.name, mimeType: mimeOf(ref.name, data), sizeBytes: data.length, dataBase64: data.toString('base64') });
  }
  if (out.length) log.info('附带文件', { count: out.length, totalBytes: total, types: out.map((f) => f.mimeType) });
  return out;
}

export interface TurnInput {
  appId: string;
  sessionKey: string;
  userKey: string;
  unionId: string;
  binding: AgentBinding;
  prompt: StoredPrompt;
  target: ReplyTarget;
  chat: { chatType: 'p2p' | 'group'; chatId: string; threadId?: string };
  /** The user message that triggered this turn, used by the "Regenerate" button */
  sourceMessageId: string;
  turnTimeoutSec: number;
  /** message_id of the queued card; at the start it is replaced in place with the streaming card */
  queuedMessageId?: string;
  /** Display name (design 6.1.1), may be absent */
  userName?: string;
  /** Whether to store the conversation title (the bot's storePromptText, design 9.2) */
  storePromptText?: boolean;
  /** Note on the card's status line, such as "⏰ scheduled task" (design 8.3) */
  note?: string;
  /** Resume call of a human confirmation (design 6.5) */
  resume?: { interruptId: string; value: string; label: string };
}

export interface TurnDeps {
  api: LarkApi;
  sessions: SessionStore;
  tokens: TokenProvider;
  fetchImpl?: FetchLike;
  streamMinIntervalMs?: number;
  now?: () => number;
}

/**
 * "View trace" link. It jumps to the AgentCore observability overview.
 */
export function traceUrlFor(runtimeArn: string, _runtimeSessionId: string): string {
  const region = regionFromRuntimeArn(runtimeArn);
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#/gen-ai-observability/agent-core`;
}

async function loadImages(api: LarkApi, prompt: StoredPrompt): Promise<{ images: InvokePayload['images']; skipped: number }> {
  const images: NonNullable<InvokePayload['images']> = [];
  let total = 0;
  let skipped = 0;
  for (const ref of prompt.images.slice(0, MAX_IMAGES)) {
    try {
      const { data, mimeType } = await api.downloadImage(ref.messageId, ref.imageKey);
      if (data.length > MAX_IMAGE_BYTES || total + data.length > MAX_IMAGES_TOTAL_BYTES || !mimeType.startsWith('image/')) {
        skipped++;
        continue;
      }
      total += data.length;
      images.push({ mimeType, dataBase64: data.toString('base64') });
    } catch (e) {
      log.warn('下载图片失败', { err: e });
      skipped++;
    }
  }
  skipped += Math.max(0, prompt.images.length - MAX_IMAGES);
  return { images, skipped };
}

export async function runTurn(input: TurnInput, deps: TurnDeps, signal: AbortSignal): Promise<void> {
  const now = deps.now ?? Date.now;
  const turnId = randomUUID();
  if (!deps.sessions.get(input.sessionKey)) throw new Error('session 不存在');
  // The current conversation of this agent at this conversation location (design 5.4)
  const session = deps.sessions.agentSession(input.sessionKey, input.binding.alias, input.binding.runtimeArn);
  const st = newTurnState(now());
  st.traceUrl = traceUrlFor(input.binding.runtimeArn, session.runtimeSessionId);
  st.retryValue = {
    a: 'retry',
    u: input.unionId,
    c: input.chat.chatId,
    ct: input.chat.chatType,
    ...(input.chat.threadId ? { t: input.chat.threadId } : {}),
    m: input.sourceMessageId,
  };
  st.attachments = input.prompt.files?.length || undefined;
  if (input.resume) st.resumeNote = `继续：已选择「${input.resume.label}」`;
  else if (input.note) st.resumeNote = input.note;
  const card = new CardStream(deps.api, input.target, st, { minIntervalMs: deps.streamMinIntervalMs });
  await card.open(input.queuedMessageId);

  // Both the timeout and shutdown abort the request through the same AbortController
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(new TurnError('SHUTDOWN', 'shutdown'));
  if (signal.aborted) onOuterAbort();
  signal.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new TurnError('TIMEOUT', 'turn timeout')), input.turnTimeoutSec * 1000);

  let firstTokenMs: number | null = null;
  let errorCode: string | null = null;
  try {
    const files = await loadFiles(deps.api, input.prompt);
    const { images, skipped } = await loadImages(deps.api, input.prompt);
    let prompt = input.prompt.text;
    // Files only, no text: tell the agent what was received (design 6.4)
    if (!prompt.trim() && files.length) prompt = `用户上传了文件：${files.map((f) => `${f.name}（${fmtBytes(f.sizeBytes)}）`).join('、')}`;
    if (skipped) prompt += `\n\n（有 ${skipped} 张图片未能附上）`;
    let token: string;
    try {
      token = await deps.tokens.getAccessToken(input.userKey, input.binding.clientId);
    } catch (e) {
      log.error('签发 token 失败', { sessionKey: input.sessionKey, turnId, err: e });
      throw new TurnError('IDENTITY', 'identity');
    }
    const payload: InvokePayload = {
      prompt,
      ...(images && images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
      actorId: input.userKey,
      conversationId: session.runtimeSessionId,
      turnId,
      ...(input.userName ? { user: { name: input.userName } } : {}),
      ...(input.resume ? { resume: { interruptId: input.resume.interruptId, value: input.resume.value } } : {}),
      chat: input.chat,
    };
    for await (const ev of invokeRuntime(
      {
        runtimeArn: input.binding.runtimeArn,
        qualifier: input.binding.qualifier,
        accessToken: token,
        runtimeSessionId: session.runtimeSessionId,
        payload,
        signal: ctrl.signal,
      },
      deps.fetchImpl,
    )) {
      if (ev.type === 'text' && firstTokenMs === null) firstTokenMs = now() - st.startedAt;
      if (applyEvent(st, ev)) card.changed();
    }
    st.phase = st.interrupt ? 'awaiting' : 'done';
    if (st.interrupt) {
      const exp = String(Math.floor(now() / 1000) + CONFIRM_TTL_SEC);
      st.interruptValues = st.interrupt.options.map((o) => ({
        a: 'resume',
        u: input.unionId,
        c: input.chat.chatId,
        ct: input.chat.chatType,
        ...(input.chat.threadId ? { t: input.chat.threadId } : {}),
        m: input.sourceMessageId,
        al: input.binding.alias,
        ep: String(session.epoch),
        iid: st.interrupt!.id,
        v: o.value,
        l: o.label,
        exp,
      }));
    }
  } catch (e) {
    const te =
      e instanceof TurnError
        ? e
        : ctrl.signal.reason instanceof TurnError
          ? ctrl.signal.reason
          : e instanceof ShutdownAbort
            ? new TurnError('SHUTDOWN', 'shutdown')
            : new TurnError('STREAM_INTERRUPTED', (e as Error)?.message ?? 'error');
    errorCode = te.code;
    st.errorCode = errorCode;
    st.phase = te.code === 'TIMEOUT' ? 'timeout' : te.code === 'SHUTDOWN' ? 'interrupted' : 'error';
    if (te.code === 'AUTH_401') deps.tokens.invalidate(input.userKey, input.binding.clientId);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onOuterAbort);
  }

  st.endedAt = now();
  try {
    st.sessionTotals = deps.sessions.finishTurn({
      turnId,
      sessionKey: input.sessionKey,
      agentAlias: input.binding.alias,
      startedAt: st.startedAt,
      endedAt: st.endedAt,
      firstTokenMs,
      inputTokens: st.usage.inputTokens,
      outputTokens: st.usage.outputTokens,
      cacheRead: st.usage.cacheReadTokens,
      cacheWrite: st.usage.cacheWriteTokens,
      model: st.usage.model ?? null,
      result: st.phase === 'done' || st.phase === 'awaiting' ? 'success' : st.phase === 'timeout' ? 'timeout' : st.phase === 'interrupted' ? 'interrupted' : 'failure',
      errorCode,
      // Record the title on the first turn of this conversation (design 8.1)
      title: session.usage.turns === 0 && input.storePromptText !== false && !input.resume ? conversationTitle(input.prompt) : null,
    });
  } catch (e) {
    log.error('写 turns 失败', { sessionKey: input.sessionKey, turnId, err: e });
  }
  const { truncated } = await card.finish(`reply-${turnId.slice(0, 8)}.md`);
  log.info('turn 结束', {
    sessionKey: input.sessionKey,
    turnId,
    result: st.phase,
    errorCode,
    elapsedMs: st.endedAt - st.startedAt,
    firstTokenMs,
    inputTokens: st.usage.inputTokens,
    outputTokens: st.usage.outputTokens,
    tools: st.tools.length,
    truncated,
  });
}
