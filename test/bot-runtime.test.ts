// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from 'vitest';
import { BotRuntime } from '../src/app/bot-runtime.ts';
import type { BotConfig } from '../src/config/bots-store.ts';
import { HmacKeyStore } from '../src/identity/hmac-secret.ts';
import { TokenProvider } from '../src/identity/token-provider.ts';
import type { CognitoApi } from '../src/identity/cognito.ts';
import { SessionQueues } from '../src/session/queue.ts';
import { SessionStore } from '../src/session/store.ts';
import { ScheduleStore } from '../src/session/schedule.ts';
import { SeenEvents } from '../src/store/seen-events.ts';
import { openDb } from '../src/store/sqlite.ts';
import { parseCommand } from '../src/commands/registry.ts';
import { parseContent, withQuote } from '../src/lark/message-parser.ts';
import { replyTargetFor } from '../src/lark/reply-target.ts';
import { FakeLark, sseFetch } from './fakes.ts';

const ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/a-1';

function bot(over: Partial<BotConfig> = {}): BotConfig {
  return {
    appId: 'cli_a',
    appSecret: 's',
    appName: 'b',
    agents: [
      { alias: 'default', runtimeArn: ARN, qualifier: 'DEFAULT', clientId: 'c1', status: 'ready', verifiedAt: null },
      { alias: 'pend', runtimeArn: ARN, qualifier: 'DEFAULT', clientId: 'c2', status: 'pending', verifiedAt: null },
    ],
    defaultAgent: 'default',
    admins: ['on_admin'],
    allowedUsers: ['on_user'],
    allowAll: false,
    turnTimeoutSec: 600,
    storePromptText: true,
    createdAt: '',
    ...over,
  };
}

const cognito: CognitoApi = {
  getUser: async () => ({ status: 'CONFIRMED', enabled: true }),
  createUser: async () => {},
  setPermanentPassword: async () => {},
  passwordAuth: async () => ({ accessToken: 'jwt', refreshToken: 'r', expiresInSec: 900 }),
  refreshAuth: async () => ({ accessToken: 'jwt', expiresInSec: 900 }),
};

async function setup(fetchImpl: typeof fetch, cfg = bot(), mutateBot?: (appId: string, fn: (b: BotConfig) => void) => Promise<void>) {
  const db = openDb(':memory:');
  const schedules = new ScheduleStore(db);
  const keys = new HmacKeyStore({ fetch: async (s) => (s === 'AWSCURRENT' ? 'k'.repeat(40) : null) });
  await keys.reload();
  const api = new FakeLark();
  const queues = new SessionQueues(5);
  const sessions = new SessionStore(db);
  const rt = new BotRuntime(cfg, api, {
    db,
    schedules,
    mutateBot,
    sessions,
    seen: new SeenEvents(db),
    queues,
    tokens: new TokenProvider(cognito, keys),
    fetchImpl,
    streamMinIntervalMs: 0,
  });
  return { rt, api, queues, sessions, schedules };
}

let evn = 0;
function msgEvent(text: string, o: { union?: string; chatType?: string; thread?: string; mention?: boolean; parent?: string } = {}) {
  const mentions = o.mention ? [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'bot' }] : [];
  return {
    event_id: `ev${++evn}`,
    sender: { sender_id: { union_id: o.union ?? 'on_user', open_id: 'ou_x' }, sender_type: 'user', tenant_key: 'tk' },
    message: {
      message_id: `om_in${evn}`,
      chat_id: 'oc_1',
      chat_type: o.chatType ?? 'p2p',
      thread_id: o.thread,
      parent_id: o.parent,
      message_type: 'text',
      content: JSON.stringify({ text: (o.mention ? '@_user_1 ' : '') + text }),
      mentions,
    },
  };
}
const idle = () => new Promise((r) => setTimeout(r, 30));

describe('parser / target / command', () => {
  it('post 富文本、@ 处理、图片', () => {
    const p = parseContent(
      {
        message_id: 'm',
        chat_id: 'c',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify({
          title: 'T',
          content: [[{ tag: 'at', user_id: 'ou_bot' }, { tag: 'text', text: 'hi ' }, { tag: 'a', text: 'L', href: 'https://x' }], [{ tag: 'img', image_key: 'img_1' }]],
        }),
      },
      'ou_bot',
    );
    expect(p.text).toBe('T\nhi [L](https://x)');
    expect(p.images).toEqual([{ messageId: 'm', imageKey: 'img_1' }]);
    expect(withQuote({ text: 'b', images: [] }, { text: 'a\nc', images: [] }).text).toBe('> a\n> c\n\nb');
  });
  it('富文本里文字 + 附件：file 节点当作文件（第 5 项实测）', () => {
    const p = parseContent(
      {
        message_id: 'm', chat_id: 'c', chat_type: 'p2p', message_type: 'post',
        content: JSON.stringify({ content: [[{ tag: 'text', text: '解读这个方案' }], [{ tag: 'file', file_key: 'fk', file_name: '方案.md' }], [{ tag: 'x_new', file_key: 'fk2' }]] }),
      },
      undefined,
    );
    expect(p.text).toBe('解读这个方案');
    expect(p.files).toEqual([{ messageId: 'm', fileKey: 'fk', name: '方案.md' }, { messageId: 'm', fileKey: 'fk2', name: 'file' }]);
  });

  it('回复位置', () => {
    expect(replyTargetFor({ messageId: 'm', chatId: 'c', chatType: 'group', threadId: 't' })).toEqual({ kind: 'reply', messageId: 'm', inThread: true });
    expect(replyTargetFor({ messageId: 'm', chatId: 'c', chatType: 'p2p' })).toEqual({ kind: 'chat', chatId: 'c' });
    expect(replyTargetFor({ messageId: 'm', chatId: 'c', chatType: 'group' })).toEqual({ kind: 'reply', messageId: 'm', inThread: false });
  });
  it('命令解析', () => {
    expect(parseCommand('/agent foo')).toMatchObject({ name: 'agent', args: ['foo'] });
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/nope')!.def).toBeUndefined();
  });
});

describe('BotRuntime', () => {
  it('私聊一轮：JWT、session 头、payload、流式卡片、去重', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const { rt, api, sessions } = await setup(
      sseFetch([{ type: 'text', delta: 'Hello' }, { type: 'usage', inputTokens: 3, outputTokens: 2 }, { type: 'done' }], {
        onRequest: (url, init) => (seen = { url, init }),
      }),
    );
    const ev = msgEvent('hi');
    await rt.handleMessage(ev);
    await rt.handleMessage(ev); // Re-delivery
    await idle();
    const h = seen!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer jwt');
    expect(h['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toMatch(/^fs-[0-9a-f]{40}$/);
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toMatchObject({ prompt: 'hi', actorId: 'feishu:tk:on_user', chat: { chatType: 'p2p', chatId: 'oc_1' } });
    expect(body.conversationId).toBe(h['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']);
    expect(api.ops('sendCard')).toHaveLength(1);
    const final = JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1]);
    expect(final).toContain('Hello');
    expect(final).toContain('已完成');
    const s = sessions.agentSession('cli_a|oc_1|feishu:tk:on_user', 'default');
    expect(s.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, turns: 1 });
  });

  it('无权限用户：关闭申请时只收到提示；/help 允许', async () => {
    const { rt, api } = await setup(sseFetch([]), bot({ accessRequests: false }));
    await rt.handleMessage(msgEvent('hi', { union: 'on_stranger' }));
    expect(JSON.stringify(api.ops('sendCard')[0]!.args[1])).toContain('权限');
    await rt.handleMessage(msgEvent('/help', { union: 'on_stranger' }));
    expect(JSON.stringify(api.ops('sendCard')[1]!.args[1])).toContain('/new');
  });

  it('陌生人申请：申请人收到提示、管理员收到卡片；24 小时内不重复；只有管理员能处理；允许后加入名单并通知', async () => {
    const mutated: BotConfig[] = [];
    const cfg = bot();
    const { rt, api } = await setup(sseFetch([{ type: 'done' }]), cfg, async (_appId, fn) => {
      fn(cfg);
      mutated.push(cfg);
      rt.updateConfig(cfg);
    });
    api.names.set('on_stranger', '王五');
    await rt.handleMessage(msgEvent('hi', { union: 'on_stranger' }));
    const toApplicant = JSON.stringify(api.ops('sendCard')[0]!.args[1]);
    expect(toApplicant).toContain('已向管理员发送申请');
    const adminCard = api.ops('sendCard')[1]!;
    expect(adminCard.args[0]).toEqual({ kind: 'user', unionId: 'on_admin' });
    expect(JSON.stringify(adminCard.args[1])).toContain('王五');
    expect(JSON.stringify(adminCard.args[1])).not.toContain('"hi"');
    await rt.handleMessage(msgEvent('hi again', { union: 'on_stranger' }));
    expect(api.ops('sendCard')).toHaveLength(3);
    expect(JSON.stringify(api.ops('sendCard')[2]!.args[1])).toContain('申请已发送');
    const value = JSON.parse(JSON.stringify(adminCard.args[1])).body.elements[1].columns[0].elements[0].behaviors[0].value;
    const click = (union: string) => rt.handleCardAction({ operator: { union_id: union }, context: { open_message_id: 'om_x' }, action: { value } });
    expect(click('on_user')).toMatchObject({ toast: { type: 'warning' } });
    expect(click('on_admin')).toMatchObject({ toast: { type: 'success' } });
    expect(click('on_admin')).toMatchObject({ toast: { content: '这个申请已经处理过了' } });
    await idle();
    expect(cfg.allowedUsers).toContain('on_stranger');
    expect(api.ops('sendText').at(-1)!.args).toEqual([{ kind: 'user', unionId: 'on_stranger' }, expect.stringContaining('已通过')]);
    await rt.handleMessage(msgEvent('now?', { union: 'on_stranger' }));
    await idle();
    expect(api.ops('cardUpdate').length).toBeGreaterThan(0);
  });

  it('群聊未 @ 不响应；@ 后用引用回复；话题用 reply_in_thread', async () => {
    const { rt, api } = await setup(sseFetch([{ type: 'done' }]));
    await rt.handleMessage(msgEvent('hi', { chatType: 'group' }));
    expect(api.calls).toHaveLength(0);
    await rt.handleMessage(msgEvent('hi', { chatType: 'group', mention: true }));
    await idle();
    expect(api.ops('sendCard')[0]!.args[0]).toMatchObject({ kind: 'reply', inThread: false });
    await rt.handleMessage(msgEvent('hi', { chatType: 'group', mention: true, thread: 'omt_1' }));
    await idle();
    expect(api.ops('sendCard')[1]!.args[0]).toMatchObject({ kind: 'reply', inThread: true });
  });

  it('同一会话串行：第二条进入排队卡片，轮到时原地替换', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let n = 0;
    const f = (async (u: string, i: RequestInit) => {
      n++;
      return sseFetch([{ type: 'text', delta: `r${n}` }], n === 1 ? { hold } : {})(u, i);
    }) as unknown as typeof fetch;
    const { rt, api, queues } = await setup(f);
    await rt.handleMessage(msgEvent('one'));
    await idle();
    await rt.handleMessage(msgEvent('two'));
    await idle();
    expect(queues.queueLength('cli_a|oc_1|feishu:tk:on_user')).toBe(1);
    const queuedCard = api.ops('sendCard')[1]!;
    expect(JSON.stringify(queuedCard.args[1])).toContain('排队中（第 1 位）');
    release();
    await idle();
    await idle();
    expect(n).toBe(2);
    expect(api.ops('idConvert').map((c) => c.args[0])).toContain('om_2');
  });

  it('pending 的绑定不处理，提示管理员 bind --verify；/agent 只列 ready', async () => {
    const { rt, api } = await setup(sseFetch([]), bot({ defaultAgent: 'pend' }));
    await rt.handleMessage(msgEvent('hi', { union: 'on_admin' }));
    expect(JSON.stringify(api.ops('sendCard')[0]!.args[1])).toContain('bind --verify');
    await rt.handleMessage(msgEvent('/agent', { union: 'on_admin' }));
    const listed = JSON.stringify(api.ops('sendCard')[1]!.args[1]);
    expect(listed).toContain('default');
    expect(listed).not.toContain('pend');
    await rt.handleMessage(msgEvent('/agent pend', { union: 'on_admin' }));
    expect(JSON.stringify(api.ops('sendCard')[2]!.args[1])).toContain('还没有通过校验');
    await rt.handleMessage(msgEvent('/agent', { union: 'on_user' }));
    expect(JSON.stringify(api.ops('sendCard')[3]!.args[1])).toContain('只有管理员');
  });

  it('/new 换 runtimeSessionId；/retry 重发；403 显示错误码', async () => {
    const ids: string[] = [];
    let status = 200;
    const f = (async (u: string, i: RequestInit) => {
      ids.push((i.headers as Record<string, string>)['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']!);
      return sseFetch([{ type: 'done' }], { status })(u, i);
    }) as unknown as typeof fetch;
    const { rt, api } = await setup(f);
    await rt.handleMessage(msgEvent('a'));
    await idle();
    await rt.handleMessage(msgEvent('/new'));
    await rt.handleMessage(msgEvent('b'));
    await idle();
    expect(ids[0]).not.toBe(ids[1]);
    status = 403;
    await rt.handleMessage(msgEvent('/retry'));
    await idle();
    expect(ids[2]).toBe(ids[1]);
    expect(JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1])).toContain('FORBIDDEN_403');
  });

  it('/new 清空 last_prompt：之后 /retry 提示没有可重发的消息', async () => {
    const { rt, api } = await setup(sseFetch([{ type: 'done' }]));
    await rt.handleMessage(msgEvent('a'));
    await idle();
    await rt.handleMessage(msgEvent('/new'));
    await rt.handleMessage(msgEvent('/retry'));
    expect(JSON.stringify(api.ops('sendCard').at(-1)!.args[1])).toContain('还没有可以重发的消息');
  });

  it('/agent 切换：两个智能体各自的 session，切回时接着上次的对话', async () => {
    const ids: string[] = [];
    const f = (async (u: string, i: RequestInit) => {
      ids.push(`${decodeURIComponent(u).split('runtime/')[1]!.split('/')[0]}:${(i.headers as Record<string, string>)['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']}`);
      return sseFetch([{ type: 'done' }])(u, i);
    }) as unknown as typeof fetch;
    const two = bot({
      agents: [
        { alias: 'default', runtimeArn: ARN, qualifier: 'DEFAULT', clientId: 'c1', status: 'ready', verifiedAt: null },
        { alias: 'raw', runtimeArn: ARN.replace('a-1', 'b-2'), qualifier: 'DEFAULT', clientId: 'c2', status: 'ready', verifiedAt: null },
      ],
    });
    const { rt, api } = await setup(f, two);
    const say = async (t: string) => {
      await rt.handleMessage(msgEvent(t, { union: 'on_admin' }));
      await idle();
    };
    await say('hi');
    await say('/agent raw');
    expect(JSON.stringify(api.ops('sendCard').at(-1)!.args[1])).toContain('开始新对话');
    await say('hi');
    await say('/agent default');
    expect(JSON.stringify(api.ops('sendCard').at(-1)!.args[1])).toContain('继续上次的对话');
    await say('hi');
    expect(ids[0]).toBe(ids[2]); // default uses the same session twice
    expect(ids[1]!.startsWith('b-2')).toBe(true);
    expect(ids[1]!.split(':')[1]).not.toBe(ids[0]!.split(':')[1]);
    await say('/new');
    await say('hi');
    expect(ids[3]).not.toBe(ids[2]); // after /new, default has a different session
    await say('/agent raw');
    expect(JSON.stringify(api.ops('sendCard').at(-1)!.args[1])).toContain('继续上次的对话');
    await say('hi');
    expect(ids[4]).toBe(ids[1]); // raw is not affected by default's /new
  });

  it('payload 带显示名（内存缓存，只查一次）；查不到时不带', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { rt, api } = await setup(sseFetch([{ type: 'done' }], { onRequest: (_u, i) => bodies.push(JSON.parse(String(i.body))) }));
    api.names.set('on_user', '张三');
    await rt.handleMessage(msgEvent('a'));
    await idle();
    await rt.handleMessage(msgEvent('b'));
    await idle();
    expect(bodies.map((b) => b.user)).toEqual([{ name: '张三' }, { name: '张三' }]);
    expect(api.ops('userName')).toHaveLength(1);
    await rt.handleMessage(msgEvent('c', { union: 'on_admin' }));
    await idle();
    expect(bodies[2]!.user).toBeUndefined();
  });

  it('文件：下载后放进 payload.files；只发文件时生成 prompt；卡片显示已附文件；超限不调用智能体', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { rt, api } = await setup(sseFetch([{ type: 'done' }], { onRequest: (_u, i) => bodies.push(JSON.parse(String(i.body))) }));
    const fileMsg = (key: string, name: string) => {
      const ev = msgEvent('');
      ev.message.message_type = 'file';
      ev.message.content = JSON.stringify({ file_key: key, file_name: name });
      return ev;
    };
    api.fileSizes.set('fk1', 2048);
    await rt.handleMessage(fileMsg('fk1', '报告.pdf'));
    await idle();
    const f = (bodies[0]!.files as { name: string; mimeType: string; sizeBytes: number; dataBase64: string }[])[0]!;
    expect(f).toMatchObject({ name: '报告.pdf', mimeType: 'application/pdf', sizeBytes: 2048 });
    expect(Buffer.from(f.dataBase64, 'base64')).toHaveLength(2048);
    expect(bodies[0]!.prompt).toBe('用户上传了文件：报告.pdf（2.0 KB）');
    expect(JSON.stringify(api.ops('sendCard').at(-1)!.args[1])).toContain('已附 1 个文件');
    api.fileSizes.set('big', 30 * 1024 * 1024);
    await rt.handleMessage(fileMsg('big', 'big.zip'));
    await idle();
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1])).toContain('FILE_TOO_LARGE');
  });

  it('人工确认：interrupt → 按钮 → 校验 → resume 调用；重复点击、换人、/new 后都不调用', async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const f = (async (u: string, i: RequestInit) => {
      bodies.push(JSON.parse(String(i.body)));
      n++;
      const evs = n === 1 || n === 3
        ? [{ type: 'tool_start', id: 't1', name: 'delete_records' },
           { type: 'interrupt', id: `iid-${n}`, name: 'approve', title: '确认删除？', detail: '{"names":["a"]}',
             options: [{ label: '确认', value: 'yes' }, { label: '取消', value: 'no' }] }, { type: 'done' }]
        : [{ type: 'text', delta: '已删除' }, { type: 'done' }];
      return sseFetch(evs)(u, i);
    }) as unknown as typeof fetch;
    const { rt, api } = await setup(f);
    await rt.handleMessage(msgEvent('删除 a'));
    await idle();
    const card = JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1]);
    expect(card).toContain('等待确认');
    expect(card).toContain('确认删除？');
    const btns = (JSON.parse(card).body.elements as { tag: string; columns?: { elements: { behaviors: { value: Record<string, string> }[] }[] }[] }[])
      .find((e) => e.tag === 'column_set' && JSON.stringify(e).includes('btn_opt_0'))!
      .columns!.map((c) => c.elements[0]!.behaviors[0]!.value);
    expect(btns.map((b) => [b.a, b.v, b.iid])).toEqual([['resume', 'yes', 'iid-1'], ['resume', 'no', 'iid-1']]);
    const click = (value: Record<string, string>, union = 'on_user') =>
      rt.handleCardAction({ operator: { union_id: union, tenant_key: 'tk' }, context: { open_message_id: 'om_1' }, action: { value } });
    expect(click(btns[0]!, 'on_admin')).toMatchObject({ toast: { type: 'warning' } });
    expect(click({ ...btns[0]!, exp: '1' })).toMatchObject({ toast: { content: expect.stringContaining('过期') } });
    expect(click(btns[0]!)).toMatchObject({ toast: { type: 'success' } });
    expect(click(btns[1]!)).toMatchObject({ toast: { content: '已经处理过了' } });
    await idle();
    await idle();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ prompt: '', resume: { interruptId: 'iid-1', value: 'yes' } });
    expect(api.ops('patchElement').map((c) => c.args[1])).toContain('btn_opt_0');
    expect(JSON.stringify(api.ops('sendCard').at(-1)!.args[1]) + JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1])).toContain('已删除');
    // A second interrupt, then /new: the old button becomes invalid
    await rt.handleMessage(msgEvent('再删 b'));
    await idle();
    const card2 = JSON.parse(JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1]));
    const v2 = JSON.stringify(card2).match(/"iid":"iid-3"/);
    expect(v2).not.toBeNull();
    await rt.handleMessage(msgEvent('/new'));
    expect(click({ ...btns[0]!, iid: 'iid-3' })).toMatchObject({ toast: { content: expect.stringContaining('新对话') } });
    await idle();
    expect(bodies).toHaveLength(3);
  });

  it('/resume：列出对话（标题、轮数、当前），切回后用旧 session；之后 /new 不撞上已有 epoch', async () => {
    const ids: string[] = [];
    const f = (async (u: string, i: RequestInit) => {
      ids.push((i.headers as Record<string, string>)['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']!);
      return sseFetch([{ type: 'done' }])(u, i);
    }) as unknown as typeof fetch;
    const { rt, api } = await setup(f);
    const say = async (t: string) => {
      await rt.handleMessage(msgEvent(t));
      await idle();
    };
    const last = () => JSON.stringify(api.ops('sendCard').at(-1)!.args[1]);
    await say('第一段对话：关于 AWS 账单的问题');
    await say('追问');
    await say('/new');
    await say('第二段');
    await say('/resume');
    expect(last()).toContain('第二段');
    expect(last()).toContain('（当前）');
    expect(last()).toContain('第一段对话：关于 AWS 账单的问');
    expect(last()).toContain('2 轮');
    await say('/resume 2');
    expect(last()).toContain('已切回');
    await say('继续第一段');
    expect(ids[3]).toBe(ids[0]);
    await say('/new');
    await say('第三段');
    expect(new Set([ids[0], ids[2], ids[4]]).size).toBe(3);
  });

  it('合并转发：展开子消息（发送人、图片、嵌套），作为 prompt 发给智能体', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { rt, api } = await setup(sseFetch([{ type: 'done' }], { onRequest: (_u, i) => bodies.push(JSON.parse(String(i.body))) }));
    const ev = msgEvent('');
    ev.message.message_type = 'merge_forward';
    ev.message.content = '{}';
    const root = ev.message.message_id;
    api.forwards.set(root, [
      { message_id: root, chat_id: 'oc', chat_type: '', message_type: 'merge_forward', content: '{}' },
      { message_id: 's1', chat_id: 'oc', chat_type: '', message_type: 'text', content: JSON.stringify({ text: '明天开会' }), upper_message_id: root, sender_name: '张三' },
      { message_id: 's2', chat_id: 'oc', chat_type: '', message_type: 'image', content: JSON.stringify({ image_key: 'img1' }), upper_message_id: root },
      { message_id: 's3', chat_id: 'oc', chat_type: '', message_type: 'merge_forward', content: '{}', upper_message_id: root, sender_name: '李四' },
    ]);
    await rt.handleMessage(ev);
    await idle();
    expect(bodies[0]!.prompt).toBe('[合并转发的聊天记录，共 3 条]\n张三：明天开会\n某人：[图片]\n李四：[合并转发]');
    expect(bodies[0]!.images).toHaveLength(1);
  });

  it('/schedule：只有管理员；add / list / remove；到期执行时以创建者身份调用，卡片标定时任务', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { rt, api, schedules } = await setup(sseFetch([{ type: 'done' }], { onRequest: (_u, i) => bodies.push(JSON.parse(String(i.body))) }));
    const last = () => JSON.stringify(api.ops('sendCard').at(-1)!.args[1]);
    await rt.handleMessage(msgEvent('/schedule add 每天 09:00 早报', { union: 'on_user' }));
    expect(last()).toContain('只有管理员');
    await rt.handleMessage(msgEvent('/schedule add 每天 09:00 总结昨天的新闻', { union: 'on_admin' }));
    expect(last()).toContain('已添加：每天 09:00');
    await rt.handleMessage(msgEvent('/schedule add 每 5 分钟 x', { union: 'on_admin' }));
    expect(last()).toContain('至少 10 分钟');
    await rt.handleMessage(msgEvent('/schedule list', { union: 'on_admin' }));
    expect(last()).toContain('总结昨天的新闻');
    const [s] = schedules.due(Date.now() + 2 * 86_400_000);
    await rt.runScheduled(s!);
    await idle();
    expect(bodies[0]).toMatchObject({ prompt: '总结昨天的新闻', actorId: 'feishu:tk:on_admin' });
    expect(api.ops('sendCard').at(-1)!.args[0]).toEqual({ kind: 'chat', chatId: 'oc_1' });
    expect(JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1])).toContain('定时任务');
    await rt.handleMessage(msgEvent('/schedule remove 1', { union: 'on_admin' }));
    expect(schedules.due(Date.now() + 2 * 86_400_000)).toHaveLength(0);
  });

  it('超时', async () => {
    const f = sseFetch([{ type: 'text', delta: 'partial' }], { hold: new Promise(() => {}) });
    const { rt, api } = await setup(f, bot({ turnTimeoutSec: 1 }));
    await rt.handleMessage(msgEvent('slow'));
    await new Promise((r) => setTimeout(r, 1200));
    const final = JSON.stringify(api.ops('cardUpdate').at(-1)!.args[1]);
    expect(final).toContain('超时');
    expect(final).toContain('partial');
  });

  it('重新生成按钮：只允许提问人，先应答再执行', async () => {
    let n = 0;
    const f = (async (u: string, i: RequestInit) => {
      n++;
      return sseFetch([{ type: 'done' }])(u, i);
    }) as unknown as typeof fetch;
    const { rt } = await setup(f);
    await rt.handleMessage(msgEvent('a'));
    await idle();
    const value = { a: 'retry', u: 'on_user', c: 'oc_1', ct: 'p2p', m: 'om_in1' };
    expect(rt.handleCardAction({ operator: { union_id: 'on_admin', tenant_key: 'tk' }, action: { value } })).toMatchObject({
      toast: { type: 'warning' },
    });
    expect(rt.handleCardAction({ event_id: 'cb1', operator: { union_id: 'on_user', tenant_key: 'tk' }, action: { value } })).toMatchObject({
      toast: { type: 'success' },
    });
    await idle();
    expect(n).toBe(2);
  });
});
