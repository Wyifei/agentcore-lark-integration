// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from 'vitest';
import { redact, REDACTED } from '../src/util/log.ts';

describe('日志脱敏', () => {
  it('凭证和正文脱敏，用量字段保留', () => {
    const r = redact({
      appSecret: 's', accessToken: 'a', refreshToken: 'r', token: 't', Authorization: 'Bearer x', cookie: 'c', csrfToken: 'x',
      prompt: 'p', text: 't', content: 'c', delta: 'd',
      inputTokens: 3, outputTokens: 4, firstTokenMs: 5, cacheReadTokens: 6, sessionKey: 'k', messageType: 'file',
    }) as Record<string, unknown>;
    for (const k of ['appSecret', 'accessToken', 'refreshToken', 'token', 'Authorization', 'cookie', 'csrfToken', 'prompt', 'text', 'content', 'delta']) {
      expect(r[k], k).toBe(REDACTED);
    }
    expect(r).toMatchObject({ inputTokens: 3, outputTokens: 4, firstTokenMs: 5, cacheReadTokens: 6, sessionKey: 'k', messageType: 'file' });
  });
});
