// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Structured logging (JSON lines to stdout, appended to serve.log by systemd).
 *
 * Uniform redaction: message text, AppSecret, tokens, cookies, and passwords are never output (design 11).
 * Callers should not pass these fields in the first place; this is a second safety net by field name.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Sensitive fields: credential-like ones match by substring; text-like ones match by the full field name.
// token matches only fields that end with token (accessToken, refreshToken, token), so usage fields such as inputTokens and firstTokenMs are not hit by mistake.
const REDACT_CONTAINS = /secret|password|passwd|cookie|authorization|credential|csrf/i;
const REDACT_SUFFIX = /token$/i;
const REDACT_EXACT = new Set(['prompt', 'text', 'content', 'body', 'delta', 'images', 'answer', 'reasoning', 'title', 'message_text']);
const isSensitiveKey = (k: string): boolean => REDACT_CONTAINS.test(k) || REDACT_SUFFIX.test(k) || REDACT_EXACT.has(k.toLowerCase());
export const REDACTED = '[redacted]';

let minLevel: Level = (process.env.AFB_LOG_LEVEL as Level) in LEVELS ? (process.env.AFB_LOG_LEVEL as Level) : 'info';
let sink: (line: string) => void = (line) => process.stdout.write(line + '\n');

export function setLogLevel(level: Level): void {
  minLevel = level;
}
/** For tests: replace the output. */
export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value instanceof Error) {
    // Keep only the type, name, and error code; message may contain a response body, so it is truncated.
    const e = value as Error & { code?: unknown; name: string; $metadata?: { httpStatusCode?: number } };
    return {
      name: e.name,
      code: typeof e.code === 'string' || typeof e.code === 'number' ? e.code : undefined,
      status: e.$metadata?.httpStatusCode,
      message: e.message?.slice(0, 300),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, component: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const rec = { ts: new Date().toISOString(), level, component, msg, ...(fields ? (redact(fields) as object) : {}) };
  sink(JSON.stringify(rec));
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function logger(component: string): Logger {
  return {
    debug: (m, f) => emit('debug', component, m, f),
    info: (m, f) => emit('info', component, m, f),
    warn: (m, f) => emit('warn', component, m, f),
    error: (m, f) => emit('error', component, m, f),
  };
}
