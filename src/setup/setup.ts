// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * The setup command (design 4.1–4.3):
 *   default: official SDK device-code authorization (registerApp)
 *   --verify <appId>: verify a manually configured app and then write it
 * After a successful registration bots.json is written, then phase one of bind runs (an unconfigured runtime is not a failure).
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';
import { addBot, DEFAULT_TURN_TIMEOUT_SEC, updateBotsFile, type BotConfig } from '../config/bots-store.ts';
import { paths } from '../config/paths.ts';
import { bindPhase1, pickRuntimeArn } from '../cli/bind.ts';
import { ask, CliError, flagStr, loadEnv, out, type CliEnv, type ParsedArgs } from '../cli/context.ts';
import { newLarkClient } from '../lark/api.ts';
import { classifyIdentity, IdentityResolveError, resolveUnionId } from '../lark/contact.ts';
import { SCOPES } from './scopes.ts';

const OPEN_API = 'https://open.feishu.cn';

function showQr(content: string, caption: string): void {
  out(caption);
  qrcode.generate(content, { small: true }, (s) => out(s));
}

/** Whether the AppID / AppSecret are valid */
export async function validateCredentials(appId: string, appSecret: string): Promise<void> {
  const r = await fetch(`${OPEN_API}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await r.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (j.code !== 0) throw new CliError(`AppID / AppSecret 校验失败：code=${j.code} ${j.msg ?? ''}`);
}

/** Whether the bot capability is enabled (bot/v3/info) */
async function checkBotCapability(client: Lark.Client): Promise<boolean> {
  try {
    const r = (await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })) as { code?: number; bot?: { open_id?: string } };
    return r.code === 0 && !!r.bot?.open_id;
  } catch {
    return false;
  }
}

/** Resolve an open_id (issued by the same app) to a union_id with the newly created app; returns undefined on failure */
async function unionIdFromOpenId(client: Lark.Client, openId: string): Promise<string | undefined> {
  try {
    const r = (await client.contact.v3.user.get({ path: { user_id: openId }, params: { user_id_type: 'open_id' } })) as {
      code?: number;
      data?: { user?: { union_id?: string } };
    };
    const u = r.code === 0 ? r.data?.user?.union_id : undefined;
    return u?.startsWith('on_') ? u : undefined;
  } catch {
    return undefined;
  }
}

async function unionIdFromUserId(client: Lark.Client, userId: string): Promise<string | undefined> {
  try {
    const r = (await client.contact.v3.user.get({ path: { user_id: userId }, params: { user_id_type: 'user_id' } })) as {
      code?: number;
      data?: { user?: { union_id?: string } };
    };
    const u = r.code === 0 ? r.data?.user?.union_id : undefined;
    return u?.startsWith('on_') ? u : undefined;
  } catch {
    return undefined;
  }
}

/** Person who scanned → union_id (design 4.3): resolve with the newly created app; if uncertain ask the user to type it, and otherwise raise an error */
async function resolveOwner(
  client: Lark.Client,
  hints: { email?: string; userId?: string; openId?: string; adminFlag?: string },
): Promise<string> {
  if (hints.adminFlag) return resolveUnionId(client, classifyIdentity(hints.adminFlag));
  if (hints.openId) {
    const u = await unionIdFromOpenId(client, hints.openId);
    if (u) return u;
  }
  if (hints.email) {
    try {
      return await resolveUnionId(client, { kind: 'email', value: hints.email });
    } catch {
      /* Keep trying */
    }
  }
  if (hints.userId) {
    const u = await unionIdFromUserId(client, hints.userId);
    if (u) return u;
  }
  out('⚠️ 无法自动确认扫码人的 union_id（新应用的通讯录权限可能还没生效）。');
  for (let i = 0; i < 3; i++) {
    const v = await ask('请输入管理员的 union_id、邮箱或手机号（留空放弃）: ');
    if (!v) break;
    try {
      return await resolveUnionId(client, classifyIdentity(v));
    } catch (e) {
      out(`  ${(e as IdentityResolveError).message}`);
    }
  }
  throw new CliError('无法确定管理员身份，没有写入配置。');
}

interface Registered {
  appId: string;
  appSecret: string;
  appName: string;
  owner: { email?: string; userId?: string; openId?: string };
  warnings: string[];
}

async function officialPath(appName: string): Promise<Registered> {
  out('\n使用官方设备码授权注册。');
  const r = await Lark.registerApp({
    source: 'agentcore-chat-bridge',
    createOnly: true,
    appPreset: { name: appName, desc: '连接 Amazon Bedrock AgentCore 智能体的飞书机器人' },
    addons: {
      scopes: { tenant: SCOPES.tenant },
      events: { items: { tenant: SCOPES.events } },
      callbacks: { items: SCOPES.callbacks },
    },
    onQRCodeReady: ({ url, expireIn }) => {
      showQr(url, `\n请用飞书 App 扫码（${Math.round(expireIn / 60)} 分钟内有效），或在浏览器打开：\n${url}\n`);
    },
  }).catch((e: unknown) => {
    const d = e as { code?: string; description?: string; message?: string };
    throw new CliError(`设备码授权失败：${d.description ?? d.message ?? d.code ?? String(e)}`);
  });
  if (r.user_info?.tenant_brand === 'lark') throw new CliError('暂不支持 Lark 国际版租户');
  return {
    appId: r.client_id,
    appSecret: r.client_secret,
    appName,
    owner: { openId: r.user_info?.open_id?.startsWith('ou_') ? r.user_info.open_id : undefined },
    warnings: [
      `请到 https://open.feishu.cn/app/${r.client_id} 确认：事件与回调的订阅方式为"长连接"、已发布版本、权限已开通（对照 setup/scopes.json）。`,
      '确认后运行 agentcore-chat-bridge status，长连接应显示为已连接。',
    ],
  };
}

async function readSecret(): Promise<string> {
  const s = await ask('请输入 AppSecret（输入不会写入日志）: ');
  if (!s) throw new CliError('AppSecret 为空');
  return s;
}

async function finish(env: CliEnv, reg: Registered, a: ParsedArgs, runtimeArn: string): Promise<void> {
  await validateCredentials(reg.appId, reg.appSecret);
  const client = newLarkClient(reg.appId, reg.appSecret);
  if (!(await checkBotCapability(client))) reg.warnings.push('机器人能力未开启或版本未发布，请到开放平台检查。');
  const admin = await resolveOwner(client, { ...reg.owner, adminFlag: flagStr(a, 'admin') });
  out(`管理员：${admin}`);

  const bot: BotConfig = {
    appId: reg.appId,
    appSecret: reg.appSecret,
    appName: reg.appName,
    agents: [],
    defaultAgent: '',
    admins: [admin],
    allowedUsers: [],
    allowAll: false,
    turnTimeoutSec: DEFAULT_TURN_TIMEOUT_SEC,
    storePromptText: true,
    createdAt: new Date().toISOString(),
  };
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    addBot(f, bot);
    return f;
  });
  out(`✅ 已写入配置：${reg.appId}`);

  // Phase one of bind: an unconfigured runtime does not make setup fail
  try {
    await bindPhase1(env, {
      appId: reg.appId,
      runtimeArn,
      qualifier: flagStr(a, 'qualifier'),
      alias: flagStr(a, 'alias'),
    });
  } catch (e) {
    out(`⚠️ 绑定智能体失败：${(e as Error).message}`);
    out(`  机器人已注册，稍后可运行 agentcore-chat-bridge bind ${reg.appId} --runtime-arn <arn>`);
  }

  for (const w of reg.warnings) out(`⚠️ ${w}`);
  out('');
  out('✅ 机器人已就绪');
  out(`  在飞书里搜索"${reg.appName}"找到机器人，或打开：https://applink.feishu.cn/client/bot/open?appId=${reg.appId}`);
  out('  默认只有管理员可以对话；在 bots.json 里配置 allowedUsers / allowAll 开放给更多人。');
}

/** Returns whether the configuration changed (a reload is needed) */
export async function setupCommand(a: ParsedArgs): Promise<boolean> {
  const env = loadEnv();
  const appName = flagStr(a, 'app-name') ?? 'AgentCore 助手';

  const verify = a.flags.verify;
  if (verify !== undefined) {
    const appId = verify === true ? a.positional[0] : verify;
    if (!appId?.startsWith('cli_')) throw new CliError('用法: setup --verify <appId> [--runtime-arn <arn>] [--admin 邮箱]');
    if (env.file.bots.some((b) => b.appId === appId)) throw new CliError(`机器人 ${appId} 已在配置里`);
    const runtimeArn = flagStr(a, 'runtime-arn') ?? (await pickRuntimeArn(env));
    const appSecret = await readSecret();
    await finish(env, { appId, appSecret, appName, owner: {}, warnings: [] }, a, runtimeArn);
    return true;
  }

  // Choose the runtime first, so we do not find out after scanning that there is no usable agent
  const runtimeArn = flagStr(a, 'runtime-arn') ?? (await pickRuntimeArn(env));

  const reg = await officialPath(appName);
  await finish(env, reg, a, runtimeArn);
  return true;
}
