// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * bind / unbind (design 4.6, 5.3).
 *
 * Two phases:
 *   (1) create a Cognito app client for this binding, record the state as pending, and print the authorizer configuration the customer's runtime needs;
 *   (2) `bind --verify`: check the configuration with GetAgentRuntime and change to ready only if it is satisfied.
 * When the checks are already satisfied (for example when binding again), phase one records ready directly. It never modifies the customer's runtime.
 */
import {
  findAgent,
  findBot,
  isValidAlias,
  isValidRuntimeArn,
  regionFromRuntimeArn,
  removeAgent,
  updateBotsFile,
  upsertAgent,
  type AgentBinding,
  type BotsFile,
} from '../config/bots-store.ts';
import { paths } from '../config/paths.ts';
import { createBindingClient, deleteBindingClient } from '../identity/cognito.ts';
import { ask, CliError, out, type CliEnv } from './context.ts';
import {
  CHECK_TEXT,
  checkRuntime,
  discoveryUrlFor,
  listRuntimes,
  MIGRATION_NOTE,
  requiredConfigSnippet,
  type RuntimeCheck,
} from './runtime-check.ts';

export interface BindOptions {
  appId: string;
  runtimeArn?: string;
  qualifier?: string;
  alias?: string;
}

/** When --runtime-arn is omitted, list the runtimes in this account and region for the user to choose from */
export async function pickRuntimeArn(env: CliEnv): Promise<string> {
  const list = await listRuntimes(env.agentcore);
  if (!list.length) throw new CliError(`${env.region} 没有 AgentCore runtime。请先部署智能体（见 examples/strands-agent）。`);
  out(`${env.region} 的 AgentCore runtime：`);
  list.forEach((r, i) => out(`  ${i + 1}. ${r.name}  ${r.status}  ${r.arn}`));
  const a = await ask('选择编号: ');
  const n = Number.parseInt(a, 10);
  const picked = list[n - 1];
  if (!picked) throw new CliError('编号无效');
  return picked.arn;
}

function allClientsForRuntime(file: BotsFile, runtimeArn: string): string[] {
  return file.bots.flatMap((b) => b.agents.filter((a) => a.runtimeArn === runtimeArn).map((a) => a.clientId));
}

function printCheckResult(env: CliEnv, file: BotsFile, binding: AgentBinding, check: RuntimeCheck | null, appId: string): void {
  const discoveryUrl = discoveryUrlFor(env.region, file.settings.userPoolId);
  if (check?.ok) {
    out(`✅ 绑定 ${binding.alias} 可用（runtime 版本 ${check.version ?? '-'}）`);
    return;
  }
  out('');
  out(`绑定 ${binding.alias} 状态：待配置（pending）`);
  out(`  app client: ${binding.clientId}`);
  if (check) {
    out('  未满足：');
    for (const m of check.missing) out(`    - ${CHECK_TEXT[m]}`);
  }
  out('');
  out('请在客户 runtime 上配置（UpdateAgentRuntime / CreateAgentRuntime）：');
  out(requiredConfigSnippet(discoveryUrl, allClientsForRuntime(file, binding.runtimeArn)));
  out('');
  if (!check || check.authMode === 'IAM') out(MIGRATION_NOTE + '\n');
  out(`配好后运行：agentcore-chat-bridge bind --verify ${appId} ${binding.alias}`);
}

/** Phase one; returns the binding (it may already be ready) */
export async function bindPhase1(env: CliEnv, opts: BindOptions): Promise<AgentBinding> {
  const alias = opts.alias ?? 'default';
  if (!isValidAlias(alias)) throw new CliError('别名只能包含字母、数字、- 和 _，最长 32');
  const qualifier = opts.qualifier ?? 'DEFAULT';
  const runtimeArn = opts.runtimeArn ?? (await pickRuntimeArn(env));
  if (!isValidRuntimeArn(runtimeArn)) throw new CliError(`runtime ARN 格式不对: ${runtimeArn}`);
  if (regionFromRuntimeArn(runtimeArn) !== env.region) {
    throw new CliError(`runtime 必须和机器人主机在同一区域（${env.region}），这个 runtime 在 ${regionFromRuntimeArn(runtimeArn)}`);
  }

  const bot = findBot(env.file, opts.appId);
  const existing = findAgent(bot, alias);
  if (existing && (existing.runtimeArn !== runtimeArn || existing.qualifier !== qualifier)) {
    throw new CliError(`别名 ${alias} 已绑定到 ${existing.runtimeArn} (${existing.qualifier})。请先 unbind，或换一个 --alias。`);
  }

  let binding: AgentBinding;
  let created = false;
  if (existing) {
    binding = existing;
    out(`别名 ${alias} 已存在，沿用 app client ${existing.clientId}`);
  } else {
    const clientId = await createBindingClient(env.cognito, env.file.settings.userPoolId, `afb-${opts.appId}-${alias}`);
    created = true;
    binding = { alias, runtimeArn, qualifier, clientId, status: 'pending', verifiedAt: null };
    out(`已创建 app client ${clientId}`);
  }

  let check: RuntimeCheck | null = null;
  try {
    check = await checkRuntime(env.agentcore, runtimeArn, qualifier, discoveryUrlFor(env.region, env.file.settings.userPoolId), binding.clientId);
  } catch (e) {
    out(`⚠️ 读取 runtime 配置失败：${(e as Error).message}`);
  }
  if (check?.ok) {
    binding = { ...binding, status: 'ready', verifiedAt: new Date().toISOString() };
  }

  try {
    env.file = await updateBotsFile(paths.botsJson(), (f) => {
      upsertAgent(findBot(f, opts.appId), binding);
      return f;
    });
  } catch (e) {
    // The configuration was not written: delete the client just created so no orphan is left
    if (created) await deleteBindingClient(env.cognito, env.file.settings.userPoolId, binding.clientId).catch(() => {});
    throw e;
  }
  printCheckResult(env, env.file, binding, check, opts.appId);
  return binding;
}

/** Phase two; when alias is omitted, verify all bindings of the bot. Returns whether any state changed */
export async function bindVerify(env: CliEnv, appId: string, alias?: string): Promise<boolean> {
  const bot = findBot(env.file, appId);
  const targets = alias ? [findAgent(bot, alias)].filter((x) => x !== undefined) : bot.agents;
  if (alias && !targets.length) throw new CliError(`机器人 ${appId} 没有别名为 ${alias} 的绑定`);
  if (!targets.length) throw new CliError(`机器人 ${appId} 还没有绑定智能体`);
  const discoveryUrl = discoveryUrlFor(env.region, env.file.settings.userPoolId);
  const results = new Map<string, RuntimeCheck>();
  for (const b of targets) {
    results.set(b.alias, await checkRuntime(env.agentcore, b.runtimeArn, b.qualifier, discoveryUrl, b.clientId));
  }
  let changed = false;
  const now = new Date().toISOString();
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    const fb = findBot(f, appId);
    for (const a of fb.agents) {
      const r = results.get(a.alias);
      if (!r) continue;
      const status = r.ok ? 'ready' : 'pending';
      if (a.status !== status) changed = true;
      a.status = status;
      if (r.ok) a.verifiedAt = now;
    }
    return f;
  });
  const fb = findBot(env.file, appId);
  for (const a of fb.agents) {
    const r = results.get(a.alias);
    if (r) printCheckResult(env, env.file, a, r, appId);
  }
  if (!fb.agents.some((a) => a.alias === fb.defaultAgent && a.status === 'ready')) {
    out(`\n提示：默认智能体 ${fb.defaultAgent} 还不可用，飞书里的对话会提示管理员先完成配置。`);
  }
  return changed;
}

export async function unbind(env: CliEnv, appId: string, alias: string): Promise<void> {
  let removed: AgentBinding | undefined;
  env.file = await updateBotsFile(paths.botsJson(), (f) => {
    removed = removeAgent(findBot(f, appId), alias);
    return f;
  });
  await deleteBindingClient(env.cognito, env.file.settings.userPoolId, removed!.clientId);
  out(`已删除绑定 ${alias} 和 app client ${removed!.clientId}`);
  out(`请从 runtime ${removed!.runtimeArn} 的 allowedClients 中移除 ${removed!.clientId}。`);
}
