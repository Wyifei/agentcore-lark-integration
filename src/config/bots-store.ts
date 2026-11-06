// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Reading and writing bots.json (design 9.1).
 *
 * - Structure `{schemaVersion, settings, bots}`; validated on read, and an invalid file is refused (throws ConfigError).
 * - Writes use "temporary file in the same directory + rename" for atomicity, with permission 0600.
 * - Changes go through `updateBotsFile`: take the file lock → read → change → validate → atomic write, so two CLIs changing it at the same time cannot lose an update.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { withFileLock } from '../util/file-lock.ts';

export const SCHEMA_VERSION = 1;
export const MAX_TURN_TIMEOUT_SEC = 3600; // Hard limit of a streaming connection is 60 minutes (design 6.3)
export const DEFAULT_TURN_TIMEOUT_SEC = 600;

export type AgentBindingStatus = 'pending' | 'ready';

export interface AgentBinding {
  alias: string;
  runtimeArn: string;
  qualifier: string;
  /** The Cognito app client of this binding (design 5.3) */
  clientId: string;
  status: AgentBindingStatus;
  verifiedAt: string | null;
}

export interface BotConfig {
  appId: string;
  appSecret: string;
  appName: string;
  agents: AgentBinding[];
  defaultAgent: string;
  /** Administrator union_ids (starting with on_, design 4.3) */
  admins: string[];
  /** union_ids of users allowed to chat */
  allowedUsers: string[];
  allowAll: boolean;
  turnTimeoutSec: number;
  /** Access-request card for strangers (design 5.2.1), on by default */
  accessRequests?: boolean;
  /** Time zone of scheduled tasks (design 8.3), Asia/Shanghai by default */
  timezone?: string;
  /** Whether to store last_prompt and the conversation title (design 9.2, on by default); the old name keepLastPrompt is still accepted when reading */
  storePromptText?: boolean;
  createdAt: string;
}

export interface GlobalSettings {
  userPoolId: string;
  hmacSecretArn: string;
  /** Optional; defaults to AWS_REGION or is inferred from userPoolId */
  region?: string;
}

export interface BotsFile {
  schemaVersion: number;
  settings: GlobalSettings;
  bots: BotConfig[];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const ALIAS_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RUNTIME_ARN_RE = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z0-9_-]+$/;
const UNION_ID_RE = /^on_[A-Za-z0-9]+$/;

export function regionOf(settings: GlobalSettings): string {
  if (settings.region) return settings.region;
  const fromPool = settings.userPoolId.split('_')[0];
  return fromPool || process.env.AWS_REGION || 'us-east-1';
}

export function regionFromRuntimeArn(arn: string): string {
  const r = arn.split(':')[3];
  if (!r) throw new ConfigError(`runtime ARN 格式不对: ${arn}`);
  return r;
}

export function isValidRuntimeArn(arn: string): boolean {
  return RUNTIME_ARN_RE.test(arn);
}
export function isValidAlias(alias: string): boolean {
  return ALIAS_RE.test(alias);
}
export function isUnionId(s: string): boolean {
  return UNION_ID_RE.test(s);
}

/** Validate the whole file; return the normalized object (with defaults filled in). Throws ConfigError when invalid. */
export function validateBotsFile(raw: unknown): BotsFile {
  const fail = (m: string): never => {
    throw new ConfigError(`bots.json 不合法：${m}`);
  };
  if (!raw || typeof raw !== 'object') fail('顶层不是对象');
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion 必须为 ${SCHEMA_VERSION}，实际为 ${String(o.schemaVersion)}`);
  const s = o.settings as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') fail('缺少 settings');
  if (typeof s!.userPoolId !== 'string' || !s!.userPoolId) fail('settings.userPoolId 缺失');
  if (typeof s!.hmacSecretArn !== 'string' || !s!.hmacSecretArn) fail('settings.hmacSecretArn 缺失');
  if (!Array.isArray(o.bots)) fail('bots 必须是数组');

  const seen = new Set<string>();
  const bots: BotConfig[] = (o.bots as unknown[]).map((b, i) => {
    const where = `bots[${i}]`;
    if (!b || typeof b !== 'object') fail(`${where} 不是对象`);
    const bot = b as Record<string, unknown>;
    if (typeof bot.appId !== 'string' || !bot.appId.startsWith('cli_')) fail(`${where}.appId 不合法`);
    if (seen.has(bot.appId as string)) fail(`appId 重复: ${String(bot.appId)}`);
    seen.add(bot.appId as string);
    if (typeof bot.appSecret !== 'string' || !bot.appSecret) fail(`${where}.appSecret 缺失`);
    if (!Array.isArray(bot.agents)) fail(`${where}.agents 必须是数组`);
    const aliases = new Set<string>();
    const agents = (bot.agents as unknown[]).map((a, j) => {
      const aw = `${where}.agents[${j}]`;
      const ag = a as Record<string, unknown>;
      if (!ag || typeof ag !== 'object') fail(`${aw} 不是对象`);
      if (typeof ag.alias !== 'string' || !ALIAS_RE.test(ag.alias)) fail(`${aw}.alias 不合法`);
      if (aliases.has(ag.alias as string)) fail(`${where} 别名重复: ${String(ag.alias)}`);
      aliases.add(ag.alias as string);
      if (typeof ag.runtimeArn !== 'string' || !RUNTIME_ARN_RE.test(ag.runtimeArn)) fail(`${aw}.runtimeArn 不合法`);
      if (typeof ag.clientId !== 'string' || !ag.clientId) fail(`${aw}.clientId 缺失`);
      if (ag.status !== 'pending' && ag.status !== 'ready') fail(`${aw}.status 必须是 pending 或 ready`);
      return {
        alias: ag.alias as string,
        runtimeArn: ag.runtimeArn as string,
        qualifier: typeof ag.qualifier === 'string' && ag.qualifier ? ag.qualifier : 'DEFAULT',
        clientId: ag.clientId as string,
        status: ag.status as AgentBindingStatus,
        verifiedAt: typeof ag.verifiedAt === 'string' ? ag.verifiedAt : null,
      };
    });
    const defaultAgent = typeof bot.defaultAgent === 'string' ? bot.defaultAgent : '';
    // defaultAgent may be empty when there are no bindings (for example when bind failed after setup); with bindings it must point at one of them.
    if (agents.length > 0 && !aliases.has(defaultAgent)) fail(`${where}.defaultAgent "${defaultAgent}" 不在 agents 中`);
    const turnTimeoutSec = bot.turnTimeoutSec === undefined ? DEFAULT_TURN_TIMEOUT_SEC : bot.turnTimeoutSec;
    if (typeof turnTimeoutSec !== 'number' || !Number.isInteger(turnTimeoutSec) || turnTimeoutSec <= 0) {
      fail(`${where}.turnTimeoutSec 必须是正整数`);
    }
    if ((turnTimeoutSec as number) > MAX_TURN_TIMEOUT_SEC) {
      fail(`${where}.turnTimeoutSec=${String(turnTimeoutSec)} 超过上限 ${MAX_TURN_TIMEOUT_SEC}`);
    }
    const strArr = (v: unknown, name: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(`${where}.${name} 必须是字符串数组`);
      return v as string[];
    };
    const admins = strArr(bot.admins, 'admins');
    for (const a of admins) if (!UNION_ID_RE.test(a)) fail(`${where}.admins 只能写 union_id（on_ 开头），不能用 open_id: ${a}`);
    return {
      appId: bot.appId as string,
      appSecret: bot.appSecret as string,
      appName: typeof bot.appName === 'string' ? bot.appName : '',
      agents,
      defaultAgent,
      admins,
      allowedUsers: strArr(bot.allowedUsers, 'allowedUsers'),
      allowAll: bot.allowAll === true,
      turnTimeoutSec: turnTimeoutSec as number,
      storePromptText: (bot.storePromptText ?? bot.keepLastPrompt) !== false,
      accessRequests: bot.accessRequests !== false,
      ...(typeof bot.timezone === 'string' && bot.timezone ? { timezone: bot.timezone } : {}),
      createdAt: typeof bot.createdAt === 'string' ? bot.createdAt : new Date(0).toISOString(),
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      userPoolId: s!.userPoolId as string,
      hmacSecretArn: s!.hmacSecretArn as string,
      ...(typeof s!.region === 'string' && s!.region ? { region: s!.region } : {}),
    },
    bots,
  };
}

export function readBotsFile(path: string): BotsFile {
  if (!existsSync(path)) throw new ConfigError(`找不到 ${path}（主机首次启动时由 user data 生成）`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${path} 不是合法 JSON: ${(e as Error).message}`);
  }
  return validateBotsFile(raw);
}

export function writeBotsFileAtomic(path: string, file: BotsFile): void {
  const valid = validateBotsFile(file); // Never write content that would be refused on the next load
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600); // umask may have loosened the mode
  renameSync(tmp, path);
}

/** Read-modify-write under a lock. mutate can change the given object directly or return a new one. */
export async function updateBotsFile<T>(path: string, mutate: (f: BotsFile) => T | Promise<T>): Promise<T> {
  return withFileLock(`${path}.lock`, async () => {
    const f = readBotsFile(path);
    const result = await mutate(f);
    writeBotsFileAtomic(path, f);
    return result;
  });
}

// ---- add, remove, and change by appId ----

export function findBot(f: BotsFile, appId: string): BotConfig {
  const b = f.bots.find((x) => x.appId === appId);
  if (!b) throw new ConfigError(`没有 appId 为 ${appId} 的机器人`);
  return b;
}

export function addBot(f: BotsFile, bot: BotConfig): void {
  if (f.bots.some((x) => x.appId === bot.appId)) throw new ConfigError(`机器人 ${bot.appId} 已存在`);
  f.bots.push(bot);
}

export function removeBot(f: BotsFile, appId: string): BotConfig {
  const i = f.bots.findIndex((x) => x.appId === appId);
  if (i < 0) throw new ConfigError(`没有 appId 为 ${appId} 的机器人`);
  return f.bots.splice(i, 1)[0]!;
}

export function findAgent(bot: BotConfig, alias: string): AgentBinding | undefined {
  return bot.agents.find((a) => a.alias === alias);
}

export function upsertAgent(bot: BotConfig, binding: AgentBinding): void {
  const i = bot.agents.findIndex((a) => a.alias === binding.alias);
  if (i >= 0) bot.agents[i] = binding;
  else bot.agents.push(binding);
  if (!bot.defaultAgent || !bot.agents.some((a) => a.alias === bot.defaultAgent)) bot.defaultAgent = binding.alias;
}

export function removeAgent(bot: BotConfig, alias: string): AgentBinding {
  const i = bot.agents.findIndex((a) => a.alias === alias);
  if (i < 0) throw new ConfigError(`机器人 ${bot.appId} 没有别名为 ${alias} 的绑定`);
  const [removed] = bot.agents.splice(i, 1);
  if (bot.defaultAgent === alias) bot.defaultAgent = bot.agents[0]?.alias ?? '';
  return removed!;
}

export function addAdmin(bot: BotConfig, unionId: string): boolean {
  if (!UNION_ID_RE.test(unionId)) throw new ConfigError(`管理员必须是 union_id（on_ 开头）: ${unionId}`);
  if (bot.admins.includes(unionId)) return false;
  bot.admins.push(unionId);
  return true;
}

export function removeAdmin(bot: BotConfig, unionId: string): boolean {
  const i = bot.admins.indexOf(unionId);
  if (i < 0) return false;
  bot.admins.splice(i, 1);
  return true;
}

export function addAllowedUser(bot: BotConfig, unionId: string): boolean {
  if (!UNION_ID_RE.test(unionId)) throw new ConfigError(`只能写 union_id（on_ 开头）: ${unionId}`);
  if (bot.allowedUsers.includes(unionId)) return false;
  bot.allowedUsers.push(unionId);
  return true;
}

export function removeAllowedUser(bot: BotConfig, unionId: string): boolean {
  const i = bot.allowedUsers.indexOf(unionId);
  if (i < 0) return false;
  bot.allowedUsers.splice(i, 1);
  return true;
}

export function emptyBotsFile(settings: GlobalSettings): BotsFile {
  return { schemaVersion: SCHEMA_VERSION, settings: { ...settings }, bots: [] };
}
