// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Service, type Connection, type ServiceDeps } from '../src/app/service.ts';
import { emptyBotsFile, writeBotsFileAtomic, type BotConfig, type BotsFile } from '../src/config/bots-store.ts';
import type { CognitoApi } from '../src/identity/cognito.ts';
import type { ConnectionHandlers } from '../src/lark/connection.ts';
import { readStatus, STATUS_STALE_MS, type ServiceStatus } from '../src/store/status-file.ts';
import { FakeLark, sseFetch } from './fakes.ts';

const ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/a-1';
const bot = (appId: string, over: Partial<BotConfig> = {}): BotConfig => ({
  appId,
  appSecret: 's1',
  appName: appId,
  agents: [{ alias: 'default', runtimeArn: ARN, qualifier: 'DEFAULT', clientId: `c-${appId}`, status: 'ready', verifiedAt: null }],
  defaultAgent: 'default',
  admins: ['on_admin'],
  allowedUsers: [],
  allowAll: false,
  turnTimeoutSec: 600,
  createdAt: '',
  ...over,
});
const cognito: CognitoApi = {
  getUser: async () => ({ status: 'CONFIRMED', enabled: true }),
  createUser: async () => {},
  setPermanentPassword: async () => {},
  passwordAuth: async () => ({ accessToken: 'jwt', refreshToken: 'r', expiresInSec: 900 }),
  refreshAuth: async () => ({ accessToken: 'jwt', expiresInSec: 900 }),
};

class FakeConn implements Connection {
  state: Connection['state'] = 'connected';
  since = new Date().toISOString();
  closed = false;
  readonly appId: string;
  readonly secret: string;
  readonly h: ConnectionHandlers;
  constructor(appId: string, secret: string, h: ConnectionHandlers) {
    this.appId = appId;
    this.secret = secret;
    this.h = h;
  }
  close() {
    this.closed = true;
    this.state = 'disconnected';
  }
}

function setup(bots: BotConfig[], fetchImpl: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'afb-svc-'));
  const botsJsonPath = join(dir, 'bots.json');
  const file = (b: BotConfig[]): BotsFile => ({ ...emptyBotsFile({ userPoolId: 'us-west-2_x', hmacSecretArn: 'arn:s' }), bots: b });
  writeBotsFileAtomic(botsJsonPath, file(bots));
  const conns: FakeConn[] = [];
  const apis = new Map<string, FakeLark>();
  let secretFetches = 0;
  const deps: ServiceDeps = {
    botsJsonPath,
    dbPath: join(dir, 'data.db'),
    statusPath: join(dir, 'status.json'),
    secretFetcher: () => ({ fetch: async (s) => (s === 'AWSCURRENT' ? (secretFetches++, 'k'.repeat(40)) : null) }),
    cognito: () => cognito,
    larkApi: (b) => {
      const a = new FakeLark();
      apis.set(b.appId, a);
      return a;
    },
    connect: (b, h) => {
      const c = new FakeConn(b.appId, b.appSecret, h);
      conns.push(c);
      return c;
    },
    fetchImpl,
    registerApp: async ({ onUrl }) => {
      onUrl('https://open.feishu.cn/page/register?x=1', 600);
      return { appId: 'cli_new', appSecret: 'newsecret', openId: 'ou_new' };
    },
    unionIdFromOpenId: async () => 'on_admin',
    createBindingClient: async () => 'client-new',
    shutdownGraceMs: 50,
    streamMinIntervalMs: 0,
  };
  const svc = new Service(deps);
  return {
    svc,
    conns,
    apis,
    deps,
    secretFetches: () => secretFetches,
    write: (b: BotConfig[]) => writeBotsFileAtomic(botsJsonPath, file(b)),
    status: () => JSON.parse(readFileSync(deps.statusPath, 'utf8')) as ServiceStatus,
  };
}

let n = 0;
const msg = (text: string) => ({
  event_id: `e${++n}`,
  sender: { sender_id: { union_id: 'on_admin' }, sender_type: 'user', tenant_key: 'tk' },
  message: { message_id: `om${n}`, chat_id: 'oc', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) },
});
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('Service', () => {
  it('启动：每个 bot 一条连接，status.json 写入并可读', async () => {
    const t = setup([bot('cli_a'), bot('cli_b')], sseFetch([{ type: 'done' }]));
    await t.svc.start();
    expect(t.conns.map((c) => c.appId)).toEqual(['cli_a', 'cli_b']);
    await tick();
    const s = t.status();
    expect(s.bots.map((b) => [b.appId, b.connection])).toEqual([['cli_a', 'connected'], ['cli_b', 'connected']]);
    expect(readStatus(t.deps.statusPath).kind).toBe('fresh');
    expect(readStatus(t.deps.statusPath, Date.now() + STATUS_STALE_MS + 1000).kind).toBe('stale');
    await t.svc.stop();
  });

  it('消息经长连接进入并完成一轮；活跃会话计入 status', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = setup([bot('cli_a')], sseFetch([{ type: 'text', delta: 'hi' }], { hold }));
    await t.svc.start();
    await t.conns[0]!.h.onMessage(msg('hello'));
    await tick();
    expect(t.status().bots[0]!.activeSessions).toBe(1);
    release();
    await tick(60);
    expect(t.status().bots[0]!.activeSessions).toBe(0);
    expect(JSON.stringify(t.apis.get('cli_a')!.ops('cardUpdate').at(-1)!.args[1])).toContain('已完成');
    await t.svc.stop();
  });

  it('SIGHUP 重载：新增连上、删除断开、换 secret 重连、配置更新；HMAC 密钥重读', async () => {
    const t = setup([bot('cli_a'), bot('cli_b')], sseFetch([{ type: 'done' }]));
    await t.svc.start();
    const fetches = t.secretFetches();
    t.write([bot('cli_a', { appName: 'renamed' }), bot('cli_c'), bot('cli_b', { appSecret: 's2' })].reverse());
    expect(await t.svc.reload()).toBe(true);
    expect([...t.svc.running.keys()].sort()).toEqual(['cli_a', 'cli_b', 'cli_c']);
    expect(t.conns.find((c) => c.appId === 'cli_a')!.closed).toBe(false);
    expect(t.svc.runtime('cli_a')!.config.appName).toBe('renamed');
    const bConns = t.conns.filter((c) => c.appId === 'cli_b');
    expect(bConns.map((c) => [c.secret, c.closed])).toEqual([['s1', true], ['s2', false]]);
    expect(t.secretFetches()).toBe(fetches + 1);
    t.write([bot('cli_c')]);
    await t.svc.reload();
    expect([...t.svc.running.keys()]).toEqual(['cli_c']);
    expect(t.conns.filter((c) => c.appId !== 'cli_c').every((c) => c.closed)).toBe(true);
    await t.svc.stop();
  });

  it('重载时进行中的轮次不受影响', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = setup([bot('cli_a')], sseFetch([{ type: 'text', delta: 'partial' }], { hold }));
    await t.svc.start();
    await t.conns[0]!.h.onMessage(msg('x'));
    await tick();
    t.write([bot('cli_a', { appName: 'changed' })]);
    await t.svc.reload();
    release();
    await tick(60);
    expect(JSON.stringify(t.apis.get('cli_a')!.ops('cardUpdate').at(-1)!.args[1])).toContain('已完成');
    await t.svc.stop();
  });

  it('新配置不合法时保持旧配置', async () => {
    const t = setup([bot('cli_a')], sseFetch([{ type: 'done' }]));
    await t.svc.start();
    writeFileSync(t.deps.botsJsonPath, '{"schemaVersion":1,"settings":{},"bots":[]}');
    expect(await t.svc.reload()).toBe(false);
    expect([...t.svc.running.keys()]).toEqual(['cli_a']);
    expect(t.conns[0]!.closed).toBe(false);
    await t.svc.stop();
  });

  it('SIGTERM 停机：断开连接；超时的轮次标"服务重启"，排队的标"未执行，请重发"', async () => {
    const t = setup([bot('cli_a')], sseFetch([{ type: 'text', delta: 'partial' }], { hold: new Promise(() => {}) }));
    await t.svc.start();
    await t.conns[0]!.h.onMessage(msg('one'));
    await tick();
    await t.conns[0]!.h.onMessage(msg('two'));
    await tick();
    await t.svc.stop();
    await tick();
    const api = t.apis.get('cli_a')!;
    expect(t.conns[0]!.closed).toBe(true);
    expect(JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1])).toContain('服务重启');
    expect(JSON.stringify(api.ops('patchCard').at(-1)!.args[1])).toContain('未执行，请重发');
    expect(t.status().bots[0]!.connection).toBe('disconnected');
    // No longer accepted after shutdown
    expect(t.svc.queues.enqueue('k', { run: async () => {} })).toEqual({ status: 'closed' });
  });
});

describe('Service：/newbot 与定时任务', () => {
  it('/newbot：私聊发链接卡片 → 写入新 bot（沿用当前智能体，pending）→ 建连接 → 发结果', async () => {
    const t = setup([bot('cli_a')], sseFetch([{ type: 'done' }]));
    await t.svc.start();
    await t.conns[0]!.h.onMessage(msg('/newbot 测试二号'));
    await tick(80);
    const cards = t.apis.get('cli_a')!.ops('sendCard').map((c) => JSON.stringify(c.args[1]));
    expect(cards.some((c) => c.includes('确认创建') && c.includes('https://open.feishu.cn/page/register'))).toBe(true);
    expect(cards.some((c) => c.includes('已创建：测试二号') && c.includes('client-new') && c.includes('bind --verify cli_new default'))).toBe(true);
    const nb = JSON.parse(readFileSync(t.deps.botsJsonPath, 'utf8')).bots.find((b: BotConfig) => b.appId === 'cli_new');
    expect(nb).toMatchObject({ appName: '测试二号', admins: ['on_admin'], defaultAgent: 'default', agents: [{ alias: 'default', runtimeArn: ARN, clientId: 'client-new', status: 'pending' }] });
    expect(t.conns.map((c) => c.appId)).toContain('cli_new');
    await t.svc.stop();
  });

  it('到期的定时任务由服务执行，并算好下次时间', async () => {
    const t = setup([bot('cli_a')], sseFetch([{ type: 'done' }]));
    await t.svc.start();
    await t.conns[0]!.h.onMessage(msg('/schedule add 每 10 分钟 汇报一下'));
    await tick();
    expect(await t.svc.runDueSchedules(Date.now() + 11 * 60_000)).toBe(1);
    await tick(60);
    expect(t.apis.get('cli_a')!.ops('cardUpdate').some((c) => JSON.stringify(c.args[1]).includes('定时任务'))).toBe(true);
    expect(await t.svc.runDueSchedules(Date.now() + 12 * 60_000)).toBe(0);
    await t.svc.stop();
  });
});
