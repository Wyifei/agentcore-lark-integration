// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/** list / status / remove / admin (design 4.6) */
import {
  addAdmin,
  addAllowedUser,
  findBot,
  removeAdmin,
  removeAllowedUser,
  removeBot,
  updateBotsFile,
  type BotConfig,
} from '../config/bots-store.ts';
import { paths } from '../config/paths.ts';
import { deleteBindingClient } from '../identity/cognito.ts';
import { newLarkClient } from '../lark/api.ts';
import { classifyIdentity, resolveUnionId } from '../lark/contact.ts';
import { readStatus, type BotStatus } from '../store/status-file.ts';
import { CliError, confirm, out, type CliEnv } from './context.ts';
import { textTable } from '../store/usage.ts';

const CONN_TEXT: Record<string, string> = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  disconnected: '已断开',
  error: '连接失败',
};

function botStatuses(): { map: Map<string, BotStatus>; note: string | null } {
  const s = readStatus(paths.statusJson());
  if (s.kind === 'missing') return { map: new Map(), note: '服务可能未运行（没有 status.json）' };
  const map = new Map(s.status.bots.map((b) => [b.appId, b]));
  if (s.kind === 'stale') return { map: new Map(), note: `服务可能未运行（status.json ${Math.round(s.ageMs / 1000)} 秒未更新）` };
  return { map, note: null };
}

/** "3 minutes ago" */
export function ago(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(sec)) return '-';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

const runtimeName = (arn: string) => arn.split('/').pop() ?? arn;
const CONN_ICON: Record<string, string> = { connected: '●', connecting: '○', reconnecting: '◐', disconnected: '○', error: '✗' };

export function list(env: CliEnv, long = false): void {
  const { map, note } = botStatuses();
  if (!env.file.bots.length) {
    out('还没有机器人。运行 agentcore-chat-bridge setup 注册一个。');
    return;
  }
  env.file.bots.forEach((b, i) => {
    const st = map.get(b.appId);
    const conn = st ? `${CONN_ICON[st.connection] ?? ''} ${CONN_TEXT[st.connection] ?? st.connection}` : '? 未知';
    if (i > 0) out('');
    out(`${b.appName || '(未命名)'}  ${b.appId}  ${conn}`);
    if (!b.agents.length) out('  （没有绑定智能体）');
    else {
      const rows = b.agents.map((a) => [
        a.alias === b.defaultAgent ? `* ${a.alias}` : `  ${a.alias}`,
        a.status === 'ready' ? '✓ 可用' : '… 待配置',
        a.qualifier,
        long ? a.runtimeArn : runtimeName(a.runtimeArn),
        long ? a.clientId : '',
      ].filter((_, j) => long || j < 4));
      const head = long ? ['智能体', '状态', 'endpoint', 'runtime', 'app client'] : ['智能体', '状态', 'endpoint', 'runtime'];
      out(textTable(head, rows).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    const people = b.allowAll ? '所有人可对话' : `可对话用户 ${b.allowedUsers.length}`;
    out(`  管理员 ${b.admins.length} · ${people} · 每轮超时 ${b.turnTimeoutSec}s${b.agents.some((a) => a.status !== 'ready') ? ' · 待配置的绑定：agentcore-chat-bridge bind --verify ' + b.appId : ''}`);
  });
  out('\n* 为默认智能体' + (long ? '' : '；--long 显示完整 runtime ARN 和 app client'));
  if (note) out(`\n⚠️ ${note}`);
}

export function status(env: CliEnv): void {
  const s = readStatus(paths.statusJson());
  if (s.kind === 'missing') {
    out('服务可能未运行（没有 status.json）。运行 agentcore-chat-bridge restart 启动。');
    return;
  }
  const st = s.status;
  const state = s.kind === 'stale' ? '⚠️ 可能未运行（状态超过 90 秒未更新）' : '● 运行中';
  out(`服务  ${state}  版本 ${st.version}  pid ${st.pid}  已运行 ${ago(st.startedAt).replace('前', '')}  状态更新于 ${ago(st.updatedAt)}`);
  out('');
  const rows = st.bots.map((b) => [
    b.appName,
    b.appId,
    `${CONN_ICON[b.connection] ?? ''} ${CONN_TEXT[b.connection] ?? b.connection}`,
    ago(b.since).replace('前', ''),
    String(b.activeSessions),
    String(b.queuedTurns),
  ]);
  out(textTable(['机器人', 'AppID', '长连接', '已持续', '进行中', '排队'], rows, [false, false, false, false, true, true]));
  const loaded = new Set(st.bots.map((b) => b.appId));
  const notLoaded = env.file.bots.filter((b) => !loaded.has(b.appId)).map((b) => b.appId);
  if (notLoaded.length) out(`\n未加载：${notLoaded.join(', ')}（运行 agentcore-chat-bridge restart 或等待 reload）`);
}

export async function remove(env: CliEnv, appId: string, yes: boolean): Promise<void> {
  const bot = findBot(env.file, appId);
  if (!yes && !(await confirm(`删除机器人 ${appId}（${bot.appName}）的配置和全部 ${bot.agents.length} 个绑定？`))) {
    throw new CliError('已取消');
  }
  let removed: BotConfig | undefined;
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    removed = removeBot(f, appId);
    return f;
  });
  for (const a of removed!.agents) {
    try {
      await deleteBindingClient(env.cognito, env.file.settings.userPoolId, a.clientId);
      out(`已删除 app client ${a.clientId}（${a.alias}）；请从 ${a.runtimeArn} 的 allowedClients 中移除它`);
    } catch (e) {
      out(`⚠️ 删除 app client ${a.clientId} 失败：${(e as Error).message}`);
    }
  }
  out(`已删除机器人 ${appId} 的配置。飞书上的应用没有删除，请在开放平台自行停用：https://open.feishu.cn/app/${appId}`);
}

export async function adminAdd(env: CliEnv, appId: string, who: string): Promise<boolean> {
  const bot = findBot(env.file, appId);
  const input = classifyIdentity(who);
  const unionId = await resolveUnionId(newLarkClient(bot.appId, bot.appSecret), input);
  let added = false;
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    added = addAdmin(findBot(f, appId), unionId);
    return f;
  });
  out(added ? `已添加管理员 ${unionId}` : `${unionId} 已经是管理员`);
  return added;
}

export async function adminRemove(env: CliEnv, appId: string, who: string): Promise<boolean> {
  const bot = findBot(env.file, appId);
  const unionId = await resolveUnionId(newLarkClient(bot.appId, bot.appSecret), classifyIdentity(who));
  let removed = false;
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    const b = findBot(f, appId);
    if (b.admins.length === 1 && b.admins[0] === unionId) throw new CliError('不能删除最后一个管理员');
    removed = removeAdmin(b, unionId);
    return f;
  });
  out(removed ? `已移除管理员 ${unionId}` : `${unionId} 不是管理员`);
  return removed;
}

export function adminList(env: CliEnv, appId: string): void {
  const bot = findBot(env.file, appId);
  if (!bot.admins.length) out('（没有管理员）');
  for (const a of bot.admins) out(a);
}

// ---- allow: users allowed to chat (design 4.6, 5.2) ----

export async function allowAdd(env: CliEnv, appId: string, who: string): Promise<boolean> {
  const bot = findBot(env.file, appId);
  const unionId = await resolveUnionId(newLarkClient(bot.appId, bot.appSecret), classifyIdentity(who));
  let added = false;
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    added = addAllowedUser(findBot(f, appId), unionId);
    return f;
  });
  out(added ? `已允许 ${unionId} 对话` : `${unionId} 已在名单里`);
  if (bot.allowAll) out('提示：这个机器人已开启 allowAll，名单暂时不起作用。');
  return added;
}

export async function allowRemove(env: CliEnv, appId: string, who: string): Promise<boolean> {
  const bot = findBot(env.file, appId);
  const unionId = await resolveUnionId(newLarkClient(bot.appId, bot.appSecret), classifyIdentity(who));
  let removed = false;
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    removed = removeAllowedUser(findBot(f, appId), unionId);
    return f;
  });
  out(removed ? `已移除 ${unionId}（Cognito 用户保留，不再为他调用智能体）` : `${unionId} 不在名单里`);
  if (bot.admins.includes(unionId)) out('提示：此人是管理员，仍可对话；要撤销请用 admin remove。');
  return removed;
}

export function allowList(env: CliEnv, appId: string): void {
  const bot = findBot(env.file, appId);
  out(`allowAll：${bot.allowAll ? '开启（飞书可见范围内的所有人都能对话）' : '关闭'}`);
  out(`可对话用户 ${bot.allowedUsers.length} 人：`);
  for (const u of bot.allowedUsers) out(`  ${u}`);
  out(`管理员 ${bot.admins.length} 人（管理员总能对话）`);
}

export async function allowAll(env: CliEnv, appId: string, on: boolean, yes: boolean): Promise<boolean> {
  const bot = findBot(env.file, appId);
  if (bot.allowAll === on) {
    out(`allowAll 已经是${on ? '开启' : '关闭'}状态`);
    return false;
  }
  if (on && !yes) {
    out('开启后，飞书应用可见范围内的所有人都能和机器人对话（群里被 @ 也会响应），');
    out('每个对话过的人都会在 Cognito 建一个用户（按月活跃用户计费）并消耗模型 token。');
    if (!(await confirm('确认开启？'))) throw new CliError('已取消');
  }
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    findBot(f, appId).allowAll = on;
    return f;
  });
  out(on ? '已开启 allowAll' : '已关闭 allowAll，只有管理员和名单里的人能对话');
  return true;
}
