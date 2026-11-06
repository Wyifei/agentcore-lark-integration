// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Call AgentCore Runtime directly over HTTPS (design 6.1, 6.3).
 * A JWT-authorized runtime does not accept SigV4, so the SDK's InvokeAgentRuntime is not used.
 */
import { normalize, type AgentEvent } from './events.ts';
import { readSse } from './sse.ts';
import { regionFromRuntimeArn } from '../config/bots-store.ts';
import { logger } from '../util/log.ts';

const log = logger('agentcore');

export interface InvokePayload {
  prompt: string;
  images?: { mimeType: string; dataBase64: string }[];
  /** Files (design 6.4) */
  files?: { name: string; mimeType: string; sizeBytes: number; dataBase64: string }[];
  actorId: string;
  conversationId: string;
  turnId: string;
  /** Display name, used only to address the user (design 6.1.1) */
  user?: { name?: string };
  chat: { chatType: 'p2p' | 'group'; chatId: string; threadId?: string };
  /** Response to a human confirmation (design 6.5) */
  resume?: { interruptId: string; value: string };
}

export interface InvokeRequest {
  runtimeArn: string;
  qualifier: string;
  accessToken: string;
  runtimeSessionId: string;
  payload: InvokePayload;
  signal?: AbortSignal;
}

/** Only the error code is shown to the user (design 6.3, 11) */
export type TurnErrorCode =
  | 'AUTH_401'
  | 'FORBIDDEN_403'
  | 'NOT_FOUND_404'
  | 'THROTTLED_429'
  | 'RUNTIME_4XX'
  | 'RUNTIME_5XX'
  | 'AGENT_ERROR'
  | 'STREAM_INTERRUPTED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'SHUTDOWN'
  | 'IDENTITY'
  | 'FILE_TOO_LARGE';

export class TurnError extends Error {
  override name = 'TurnError';
  readonly code: TurnErrorCode;
  constructor(code: TurnErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function invocationUrl(runtimeArn: string, qualifier: string): string {
  const region = regionFromRuntimeArn(runtimeArn);
  const host = process.env.AFB_AGENTCORE_ENDPOINT || `https://bedrock-agentcore.${region}.amazonaws.com`;
  return `${host}/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=${encodeURIComponent(qualifier)}`;
}

function statusCode(status: number): TurnErrorCode {
  if (status === 401) return 'AUTH_401';
  if (status === 403) return 'FORBIDDEN_403';
  if (status === 404) return 'NOT_FOUND_404';
  if (status === 429) return 'THROTTLED_429';
  return status >= 500 ? 'RUNTIME_5XX' : 'RUNTIME_4XX';
}

export type FetchLike = typeof fetch;

/**
 * Call the runtime and produce normalized events. On success the last event is guaranteed to be `done`;
 * on failure it throws TurnError (an `error` event in the stream is also turned into TurnError('AGENT_ERROR')).
 */
export async function* invokeRuntime(req: InvokeRequest, fetchImpl: FetchLike = fetch): AsyncGenerator<AgentEvent> {
  let res: Response;
  try {
    res = await fetchImpl(invocationUrl(req.runtimeArn, req.qualifier), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.accessToken}`,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': req.runtimeSessionId,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(req.payload),
      signal: req.signal,
    });
  } catch (e) {
    if (req.signal?.aborted) throw abortError(req.signal);
    throw new TurnError('NETWORK', (e as Error).message);
  }

  if (!res.ok) {
    // AWS error responses contain no user content; truncate and log them to ease troubleshooting (for example a client that is not in allowedClients)
    const text = await res.text().catch(() => '');
    log.warn('runtime 返回非 2xx', {
      status: res.status,
      errorType: res.headers.get('x-amzn-errortype') ?? undefined,
      requestId: res.headers.get('x-amzn-requestid') ?? undefined,
      awsError: text.slice(0, 300),
    });
    throw new TurnError(statusCode(res.status), `HTTP ${res.status}`);
  }
  if (!res.body) throw new TurnError('STREAM_INTERRUPTED', 'empty body');

  const ctype = res.headers.get('content-type') ?? '';
  try {
    if (!ctype.includes('text/event-stream')) {
      // The agent did not return with a generator: treat the whole response body as one payload
      const text = await res.text();
      yield* emitPayload(nonStreamingBody(text));
      yield { type: 'done' };
      return;
    }
    for await (const data of readSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
      for (const ev of emitPayload(data)) {
        if (ev.type === 'error') throw new TurnError('AGENT_ERROR', ev.code ?? 'agent error');
        yield ev;
        if (ev.type === 'done') return;
      }
    }
  } catch (e) {
    if (e instanceof TurnError) throw e;
    if (req.signal?.aborted) throw abortError(req.signal);
    throw new TurnError('STREAM_INTERRUPTED', (e as Error).message);
  }
  // The stream ended normally; treat it as success even without a done event
  yield { type: 'done' };
}

function abortError(signal: AbortSignal): TurnError {
  const reason = signal.reason;
  if (reason instanceof TurnError) return reason;
  return new TurnError('TIMEOUT', 'aborted');
}

/** Non-streaming response: {"result": "..."} or a plain JSON string */
function nonStreamingBody(text: string): string {
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && typeof (v as { result?: unknown }).result === 'string') {
      return JSON.stringify((v as { result: string }).result);
    }
  } catch {
    /* Handle as is */
  }
  return text;
}

function* emitPayload(data: string): Generator<AgentEvent> {
  const { events, unknown } = normalize(data);
  if (unknown) log.debug('忽略无法识别的事件', { size: data.length });
  yield* events;
}
