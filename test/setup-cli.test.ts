// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from 'vitest';
import { evaluateRuntime, discoveryUrlFor, runtimeIdOf } from '../src/cli/runtime-check.ts';
import { parseArgs } from '../src/cli/context.ts';
import { classifyIdentity } from '../src/lark/contact.ts';

describe('bind 检查', () => {
  const url = discoveryUrlFor('us-west-2', 'us-west-2_abc');
  it('三项都满足', () => {
    const r = evaluateRuntime(
      {
        authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: url, allowedClients: ['c1', 'c2'] } },
        requestHeaderConfiguration: { requestHeaderAllowlist: ['authorization'] },
      },
      url,
      'c2',
    );
    expect(r).toEqual({ ok: true, missing: [], authMode: 'JWT' });
  });
  it('IAM runtime 全部缺', () => {
    expect(evaluateRuntime({}, url, 'c1')).toEqual({ ok: false, missing: ['discoveryUrl', 'allowedClients', 'authorizationHeader'], authMode: 'IAM' });
  });
  it('指向别的用户池', () => {
    const r = evaluateRuntime(
      {
        authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: discoveryUrlFor('us-west-2', 'other'), allowedClients: ['c1'] } },
        requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      },
      url,
      'c1',
    );
    expect(r.missing).toEqual(['discoveryUrl']);
  });
  it('runtimeIdOf', () => expect(runtimeIdOf('arn:aws:bedrock-agentcore:us-west-2:1:runtime/abc-123')).toBe('abc-123'));
});

describe('CLI', () => {
  it('parseArgs', () => {
    expect(parseArgs(['cli_a', '--runtime-arn', 'x', '--verify', '--alias=b'], ['verify'])).toEqual({
      positional: ['cli_a'],
      flags: { 'runtime-arn': 'x', verify: true, alias: 'b' },
    });
  });
  it('身份分类', () => {
    expect(classifyIdentity('on_abc').kind).toBe('union_id');
    expect(classifyIdentity('user@example.com').kind).toBe('email');
    expect(classifyIdentity('+86 138-0000-0000'.replace(' ', '')).kind).toBe('mobile');
    expect(() => classifyIdentity('ou_xxx')).toThrow(/open_id/);
  });
});
