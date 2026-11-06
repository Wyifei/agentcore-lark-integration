// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPhase1, bindVerify, unbind } from '../src/cli/bind.ts';
import { adminList, list, remove, status } from '../src/cli/manage.ts';
import type { CliEnv } from '../src/cli/context.ts';
import { emptyBotsFile, readBotsFile, writeBotsFileAtomic, type BotConfig } from '../src/config/bots-store.ts';
import { paths } from '../src/config/paths.ts';
import { discoveryUrlFor } from '../src/cli/runtime-check.ts';

const REGION = 'us-west-2';
const POOL = 'us-west-2_pool';
const ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agent-1';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

/** Fake AWS client: dispatches by command class name */
function fakeClients(runtimeCfg: () => Record<string, unknown>) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let nextClient = 0;
  const cognito = {
    send: async (c: Cmd) => {
      calls.push({ name: c.constructor.name, input: c.input });
      if (c.constructor.name === 'CreateUserPoolClientCommand') return { UserPoolClient: { ClientId: `client${++nextClient}` } };
      return {};
    },
  };
  const agentcore = {
    send: async (c: Cmd) => {
      calls.push({ name: c.constructor.name, input: c.input });
      if (c.constructor.name === 'GetAgentRuntimeEndpointCommand') return { liveVersion: '3' };
      if (c.constructor.name === 'GetAgentRuntimeCommand') return runtimeCfg();
      if (c.constructor.name === 'ListAgentRuntimesCommand') return { agentRuntimes: [{ agentRuntimeArn: ARN, agentRuntimeName: 'a', status: 'READY' }] };
      return {};
    },
  };
  return { cognito, agentcore, calls };
}

function bot(): BotConfig {
  return {
    appId: 'cli_a',
    appSecret: 's',
    appName: 'A',
    agents: [],
    defaultAgent: '',
    admins: ['on_admin'],
    allowedUsers: [],
    allowAll: false,
    turnTimeoutSec: 600,
    createdAt: '',
  };
}

let output: string[] = [];
let runtime: Record<string, unknown> = {};
let env: CliEnv;
let calls: { name: string; input: Record<string, unknown> }[];

beforeEach(() => {
  process.env.AFB_DATA_DIR = mkdtempSync(join(tmpdir(), 'afb-cli-'));
  writeBotsFileAtomic(paths.botsJson(), { ...emptyBotsFile({ userPoolId: POOL, hmacSecretArn: 'arn:s', region: REGION }), bots: [bot()] });
  output = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (output.push(String(s)), true));
  runtime = {};
  const f = fakeClients(() => runtime);
  calls = f.calls;
  env = { file: readBotsFile(paths.botsJson()), region: REGION, cognito: f.cognito as never, agentcore: f.agentcore as never };
});

const okRuntime = (clients: string[]) => ({
  authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: discoveryUrlFor(REGION, POOL), allowedClients: clients } },
  requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
});
const text = () => output.join('');

describe('bind 两阶段', () => {
  it('第一阶段：建 client（只开两种认证流、15 分钟 / 30 天、无 secret），pending，打印配置片段', async () => {
    const b = await bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN });
    expect(b).toMatchObject({ alias: 'default', clientId: 'client1', status: 'pending' });
    const create = calls.find((c) => c.name === 'CreateUserPoolClientCommand')!.input;
    expect(create).toMatchObject({
      UserPoolId: POOL,
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      AccessTokenValidity: 15,
      RefreshTokenValidity: 30,
    });
    expect(calls.find((c) => c.name === 'GetAgentRuntimeCommand')!.input).toMatchObject({ agentRuntimeId: 'agent-1', agentRuntimeVersion: '3' });
    const saved = readBotsFile(paths.botsJson()).bots[0]!;
    expect(saved.defaultAgent).toBe('default');
    expect(saved.agents[0]!.status).toBe('pending');
    expect(text()).toContain('"allowedClients"');
    expect(text()).toContain('client1');
    expect(text()).toContain('bind --verify cli_a default');
    expect(text()).toContain('互斥'); // An IAM runtime gets the migration hint
  });

  it('第二阶段：配置好后 verify 变为 ready；缺项时指出缺哪项', async () => {
    await bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN });
    runtime = { ...okRuntime(['client1']), requestHeaderConfiguration: { requestHeaderAllowlist: [] } };
    expect(await bindVerify(env, 'cli_a')).toBe(false);
    expect(text()).toContain('requestHeaderAllowlist 不包含 Authorization');
    runtime = okRuntime(['client1']);
    expect(await bindVerify(env, 'cli_a', 'default')).toBe(true);
    const a = readBotsFile(paths.botsJson()).bots[0]!.agents[0]!;
    expect(a.status).toBe('ready');
    expect(a.verifiedAt).toBeTruthy();
  });

  it('已满足检查时第一阶段直接 ready；同别名重复 bind 沿用 client', async () => {
    runtime = okRuntime(['client1']);
    expect((await bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN })).status).toBe('ready');
    await bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN });
    expect(calls.filter((c) => c.name === 'CreateUserPoolClientCommand')).toHaveLength(1);
  });

  it('拒绝：跨区域 runtime、别名已绑到别的 runtime', async () => {
    await expect(bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN.replace(/us-west-2/g, 'us-east-1') })).rejects.toThrow(/同一区域/);
    await bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN });
    await expect(bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN.replace('agent-1', 'agent-2') })).rejects.toThrow(/unbind/);
  });

  it('写配置失败时删掉刚建的 client', async () => {
    writeFileSync(paths.botsJson(), '{broken');
    await expect(bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN })).rejects.toThrow();
    expect(calls.map((c) => c.name)).toContain('DeleteUserPoolClientCommand');
  });

  it('unbind 删除绑定和 client；remove 删除 bot 和全部 client', async () => {
    await bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN });
    await bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN, alias: 'b' });
    await unbind(env, 'cli_a', 'default');
    const after = readBotsFile(paths.botsJson()).bots[0]!;
    expect(after.agents.map((a) => a.alias)).toEqual(['b']);
    expect(after.defaultAgent).toBe('b');
    expect(calls.filter((c) => c.name === 'DeleteUserPoolClientCommand').map((c) => c.input.ClientId)).toEqual(['client1']);
    await remove(env, 'cli_a', true);
    expect(readBotsFile(paths.botsJson()).bots).toEqual([]);
    expect(calls.filter((c) => c.name === 'DeleteUserPoolClientCommand').map((c) => c.input.ClientId)).toEqual(['client1', 'client2']);
    expect(text()).toContain('开放平台自行停用');
  });
});

describe('list / status / admin list', () => {
  it('没有 status.json 时提示服务可能未运行', async () => {
    await bindPhase1(env, { appId: 'cli_a', runtimeArn: ARN });
    output = [];
    list(env);
    expect(text()).toContain('cli_a');
    expect(text()).toContain('待配置');
    expect(text()).toContain('服务可能未运行');
    output = [];
    status(env);
    expect(text()).toContain('服务可能未运行');
    output = [];
    adminList(env, 'cli_a');
    expect(text()).toContain('on_admin');
  });
});

import { adminAdd, adminRemove } from '../src/cli/manage.ts';
import { resolveUnionId } from '../src/lark/contact.ts';

describe('admin', () => {
  it('add / remove union_id；不能删最后一个管理员', async () => {
    expect(await adminAdd(env, 'cli_a', 'on_new')).toBe(true);
    expect(await adminAdd(env, 'cli_a', 'on_new')).toBe(false);
    expect(readBotsFile(paths.botsJson()).bots[0]!.admins).toEqual(['on_admin', 'on_new']);
    expect(await adminRemove(env, 'cli_a', 'on_admin')).toBe(true);
    await expect(adminRemove(env, 'cli_a', 'on_new')).rejects.toThrow(/最后一个管理员/);
    await expect(adminAdd(env, 'cli_a', 'ou_openid')).rejects.toThrow(/open_id/);
  });

  it('邮箱 / 手机号用 bot 的应用解析成 union_id；找不到就报错', async () => {
    const client = (resp: unknown) =>
      ({ contact: { v3: { user: { batchGetId: async (req: unknown) => ((client as unknown as { last: unknown }).last = req, resp) } } } }) as never;
    const ok = client({ code: 0, data: { user_list: [{ user_id: 'on_x', email: 'a@b.c' }] } });
    expect(await resolveUnionId(ok, { kind: 'email', value: 'a@b.c' })).toBe('on_x');
    expect((client as unknown as { last: unknown }).last).toMatchObject({ params: { user_id_type: 'union_id' }, data: { emails: ['a@b.c'] } });
    await expect(resolveUnionId(client({ code: 0, data: { user_list: [{ email: 'a@b.c' }] } }), { kind: 'email', value: 'a@b.c' })).rejects.toThrow(/没有找到/);
    await expect(resolveUnionId(client({ code: 99991672, msg: 'no perm' }), { kind: 'mobile', value: '+8613800000000' })).rejects.toThrow(/99991672/);
    await expect(resolveUnionId(client({ code: 0, data: { user_list: [{ user_id: 'ou_x' }] } }), { kind: 'email', value: 'a@b.c' })).rejects.toThrow(/不是 union_id/);
  });
});

import { allowAdd, allowAll, allowList, allowRemove } from '../src/cli/manage.ts';

describe('allow', () => {
  it('add / remove / list / all', async () => {
    expect(await allowAdd(env, 'cli_a', 'on_u1')).toBe(true);
    expect(await allowAdd(env, 'cli_a', 'on_u1')).toBe(false);
    expect(readBotsFile(paths.botsJson()).bots[0]!.allowedUsers).toEqual(['on_u1']);
    expect(await allowAll(env, 'cli_a', true, true)).toBe(true);
    expect(readBotsFile(paths.botsJson()).bots[0]!.allowAll).toBe(true);
    output = [];
    allowList(env, 'cli_a');
    expect(text()).toContain('开启');
    expect(text()).toContain('on_u1');
    expect(await allowRemove(env, 'cli_a', 'on_u1')).toBe(true);
    expect(await allowAll(env, 'cli_a', false, false)).toBe(true);
    const b = readBotsFile(paths.botsJson()).bots[0]!;
    expect([b.allowAll, b.allowedUsers]).toEqual([false, []]);
    await expect(allowAdd(env, 'cli_a', 'ou_x')).rejects.toThrow(/open_id/);
  });
});

import { rotateSecret } from '../src/cli/rotate.ts';
import { derivePassword } from '../src/identity/password.ts';

describe('rotate-secret', () => {
  it('没有 AWSPREVIOUS 时拒绝；有时为所有用户（含分页）重设成 AWSCURRENT 派生的密码', async () => {
    const sets: { u: string; p: string }[] = [];
    let page = 0;
    env.cognito = {
      send: async (c: Cmd) => {
        if (c.constructor.name === 'ListUsersCommand') {
          page++;
          return page === 1 ? { Users: [{ Username: 'u1' }, { Username: 'u2' }], PaginationToken: 't' } : { Users: [{ Username: 'u3' }] };
        }
        if (c.constructor.name === 'AdminSetUserPasswordCommand') sets.push({ u: c.input.Username as string, p: c.input.Password as string });
        return {};
      },
    } as never;
    const NEW = 'n'.repeat(40);
    await expect(rotateSecret(env, true, { fetch: async (s) => (s === 'AWSCURRENT' ? NEW : null) })).rejects.toThrow(/AWSPREVIOUS/);
    page = 0;
    const r = await rotateSecret(env, true, { fetch: async (s) => (s === 'AWSCURRENT' ? NEW : 'o'.repeat(40)) });
    expect(r).toEqual({ total: 3, ok: 3, failed: 0 });
    expect(sets).toEqual(['u1', 'u2', 'u3'].map((u) => ({ u, p: derivePassword(Buffer.from(NEW), u) })));
  });
});
