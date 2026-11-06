// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from 'vitest';
import { derivePassword } from '../src/identity/password.ts';
import { userKeyOf, MissingIdentityError } from '../src/identity/user-key.ts';
import { HmacKeyStore, type SecretFetcher } from '../src/identity/hmac-secret.ts';
import { TokenProvider } from '../src/identity/token-provider.ts';
import {
  RefreshRejectedError,
  UserNotFoundError,
  UsernameExistsError,
  WrongPasswordError,
  UserDisabledError,
  type CognitoApi,
} from '../src/identity/cognito.ts';

const K1 = 'k'.repeat(40);
const K2 = 'z'.repeat(40);

describe('password', () => {
  it('确定性、满足复杂度', () => {
    const a = derivePassword(Buffer.from(K1), 'feishu:t:on_1');
    expect(a).toBe(derivePassword(Buffer.from(K1), 'feishu:t:on_1'));
    expect(a).not.toBe(derivePassword(Buffer.from(K1), 'feishu:t:on_2'));
    expect(a).not.toBe(derivePassword(Buffer.from(K2), 'feishu:t:on_1'));
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[^A-Za-z0-9]/);
    expect(a.length).toBeGreaterThanOrEqual(12);
    expect(a.length).toBeLessThanOrEqual(256);
  });
});

describe('userKey', () => {
  it('拼接', () => expect(userKeyOf('t1', 'on_x')).toBe('feishu:t1:on_x'));
  it('缺字段拒绝', () => {
    expect(() => userKeyOf(undefined, 'on_x')).toThrow(MissingIdentityError);
    expect(() => userKeyOf('t', undefined)).toThrow(MissingIdentityError);
    expect(() => userKeyOf('t', 'ou_x')).toThrow(MissingIdentityError);
  });
});

async function keys(prev: string | null = null) {
  const f: SecretFetcher = { fetch: async (s) => (s === 'AWSCURRENT' ? K1 : prev) };
  const ks = new HmacKeyStore(f);
  await ks.reload();
  return ks;
}

class FakeCognito implements CognitoApi {
  users = new Map<string, { password?: string; status: string; enabled: boolean }>();
  calls: string[] = [];
  refreshOk = true;
  expiresIn = 900;
  n = 0;
  async getUser(u: string) {
    this.calls.push('getUser');
    const x = this.users.get(u);
    return x ? { status: x.status, enabled: x.enabled } : null;
  }
  async createUser(u: string) {
    this.calls.push('createUser');
    if (this.users.has(u)) throw new UsernameExistsError(u);
    this.users.set(u, { status: 'FORCE_CHANGE_PASSWORD', enabled: true });
  }
  async setPermanentPassword(u: string, p: string) {
    this.calls.push('setPassword');
    const x = this.users.get(u)!;
    x.password = p;
    x.status = 'CONFIRMED';
  }
  async passwordAuth(_c: string, u: string, p: string) {
    this.calls.push('passwordAuth');
    const x = this.users.get(u);
    if (!x) throw new UserNotFoundError('');
    if (!x.enabled) throw new UserDisabledError('');
    if (x.password !== p) throw new WrongPasswordError('');
    return { accessToken: `at${++this.n}`, refreshToken: `rt${this.n}`, expiresInSec: this.expiresIn };
  }
  async refreshAuth(_c: string, _r: string) {
    this.calls.push('refresh');
    if (!this.refreshOk) throw new RefreshRejectedError('');
    return { accessToken: `at${++this.n}`, expiresInSec: this.expiresIn };
  }
}

describe('TokenProvider', () => {
  it('新用户：建用户 → 设密码 → 认证；之后命中缓存', async () => {
    const c = new FakeCognito();
    const tp = new TokenProvider(c, await keys());
    expect(await tp.getAccessToken('u', 'c1')).toBe('at1');
    expect(await tp.getAccessToken('u', 'c1')).toBe('at1');
    expect(c.calls).toEqual(['getUser', 'createUser', 'setPassword', 'passwordAuth']);
  });

  it('过期前 2 分钟用 refresh token；refresh 失效改用密码', async () => {
    let now = 0;
    const c = new FakeCognito();
    const tp = new TokenProvider(c, await keys(), () => now);
    await tp.getAccessToken('u', 'c1');
    now = 900_000 - 119_000; // Less than 2 minutes remaining
    expect(await tp.getAccessToken('u', 'c1')).toBe('at2');
    expect(c.calls.at(-1)).toBe('refresh');
    now += 900_000;
    c.refreshOk = false;
    c.calls = [];
    expect(await tp.getAccessToken('u', 'c1')).toBe('at3');
    expect(c.calls).toEqual(['refresh', 'passwordAuth']);
  });

  it('CURRENT 失败后只用 PREVIOUS 试一次，不重试 CURRENT', async () => {
    const c = new FakeCognito();
    c.users.set('u', { status: 'CONFIRMED', enabled: true, password: derivePassword(Buffer.from(K2), 'u') });
    const tp = new TokenProvider(c, await keys(K2));
    expect(await tp.getAccessToken('u', 'c1')).toBe('at1');
    expect(c.calls.filter((x) => x === 'passwordAuth')).toHaveLength(2);
  });

  it('两个版本都不对：一共两次认证，然后报错', async () => {
    const c = new FakeCognito();
    c.users.set('u', { status: 'CONFIRMED', enabled: true, password: 'other' });
    const tp = new TokenProvider(c, await keys(K2));
    await expect(tp.getAccessToken('u', 'c1')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(c.calls.filter((x) => x === 'passwordAuth')).toHaveLength(2);
  });

  it('没有 PREVIOUS 时只试一次', async () => {
    const c = new FakeCognito();
    c.users.set('u', { status: 'CONFIRMED', enabled: true, password: 'other' });
    const tp = new TokenProvider(c, await keys(null));
    await expect(tp.getAccessToken('u', 'c1')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(c.calls.filter((x) => x === 'passwordAuth')).toHaveLength(1);
  });

  it('禁用用户不回退 PREVIOUS', async () => {
    const c = new FakeCognito();
    c.users.set('u', { status: 'CONFIRMED', enabled: false, password: 'x' });
    const tp = new TokenProvider(c, await keys(K2));
    await expect(tp.getAccessToken('u', 'c1')).rejects.toBeInstanceOf(UserDisabledError);
    expect(c.calls.filter((x) => x === 'passwordAuth')).toHaveLength(1);
  });

  it('并发请求合并为一次认证', async () => {
    const c = new FakeCognito();
    const tp = new TokenProvider(c, await keys());
    const r = await Promise.all([1, 2, 3, 4].map(() => tp.getAccessToken('u', 'c1')));
    expect(new Set(r).size).toBe(1);
    expect(c.calls.filter((x) => x === 'passwordAuth')).toHaveLength(1);
  });

  it('不同 client 分别缓存', async () => {
    const c = new FakeCognito();
    const tp = new TokenProvider(c, await keys());
    expect(await tp.getAccessToken('u', 'c1')).not.toBe(await tp.getAccessToken('u', 'c2'));
  });

  it('FORCE_CHANGE_PASSWORD 的已有用户补设密码；并发创建时 UsernameExists 视为已存在', async () => {
    const c = new FakeCognito();
    c.users.set('u', { status: 'FORCE_CHANGE_PASSWORD', enabled: true });
    const tp = new TokenProvider(c, await keys());
    await tp.getAccessToken('u', 'c1');
    expect(c.calls).toEqual(['getUser', 'setPassword', 'passwordAuth']);

    const c2 = new FakeCognito();
    c2.getUser = async () => null; // It looks nonexistent but was actually created concurrently
    c2.users.set('v', { status: 'FORCE_CHANGE_PASSWORD', enabled: true });
    const tp2 = new TokenProvider(c2, await keys());
    expect(await tp2.getAccessToken('v', 'c1')).toBe('at1');
  });
});
