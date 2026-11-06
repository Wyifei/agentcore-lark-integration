// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Entry point: agentcore-chat-bridge <subcommand>
 * In production it is invoked by /opt/agentcore-feishu-bot/bin/afb as afbot (design 4.7).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigError, emptyBotsFile, writeBotsFileAtomic } from './config/bots-store.ts';
import { isDev, paths, VERSION } from './config/paths.ts';
import { bindPhase1, bindVerify, unbind } from './cli/bind.ts';
import { CliError, flagStr, loadEnv, out, parseArgs, requestReload } from './cli/context.ts';
import { adminAdd, adminList, adminRemove, allowAdd, allowAll, allowList, allowRemove, list, remove, status } from './cli/manage.ts';
import { logger } from './util/log.ts';

const USAGE = `用法: agentcore-chat-bridge <命令>

  setup [--runtime-arn <arn>] [--qualifier DEFAULT] [--app-name 名称]   扫码注册飞书机器人并绑定智能体
  setup --verify <appId>                                              校验手动配置的应用
  bind <appId> [--runtime-arn <arn>] [--qualifier Q] [--alias A]      给机器人增加一个智能体（第一阶段）
  bind --verify <appId> [alias]                                       检查 runtime 配置，通过后改为可用
  unbind <appId> <alias>                                              删除绑定和对应的 app client
  list                                                                列出机器人和绑定
  remove <appId> [--yes]                                              删除机器人配置（不删除飞书应用）
  status                                                              服务和长连接状态
  admin add|remove <appId> <union_id|邮箱|手机号>                      管理管理员
  admin list <appId>
  allow add|remove <appId> <union_id|邮箱|手机号>                      管理可对话用户
  allow list <appId> / allow all <appId> on|off [--yes]
  usage [appId] [--days 7] [--markdown]                               用量统计（默认按列对齐，--markdown 输出 markdown 表格）
  restart | logs                                                      重启服务 / 查看日志
  update                                                              升级（以 root 运行，由包装脚本处理）
  rotate-secret [--apply]                                             HMAC 密钥轮换（先在自己电脑写入新版本）
  serve                                                               运行服务（systemd 调用）
  init-config --user-pool-id <id> --hmac-secret-arn <arn>             本机开发：生成空的 bots.json
  version`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'serve': {
      const { serve } = await import('./app/service.ts');
      await serve();
      return;
    }
    case 'setup': {
      const { setupCommand } = await import('./setup/setup.ts');
      const a = parseArgs(rest, []);
      const changed = await setupCommand(a);
      if (changed) requestReload();
      return;
    }
    case 'bind': {
      const a = parseArgs(rest, []);
      const env = loadEnv();
      const verify = a.flags.verify;
      if (verify !== undefined) {
        // bind --verify <appId> [alias]
        const appId = verify === true ? a.positional[0] : verify;
        const alias = verify === true ? a.positional[1] : a.positional[0];
        if (!appId) throw new CliError('用法: bind --verify <appId> [alias]');
        if (await bindVerify(env, appId, alias)) requestReload();
        return;
      }
      const appId = a.positional[0];
      if (!appId) throw new CliError('用法: bind <appId> [--runtime-arn <arn>] [--qualifier Q] [--alias A]');
      await bindPhase1(env, {
        appId,
        runtimeArn: flagStr(a, 'runtime-arn'),
        qualifier: flagStr(a, 'qualifier'),
        alias: flagStr(a, 'alias'),
      });
      requestReload();
      return;
    }
    case 'unbind': {
      const [appId, alias] = rest;
      if (!appId || !alias) throw new CliError('用法: unbind <appId> <alias>');
      await unbind(loadEnv(), appId, alias);
      requestReload();
      return;
    }
    case 'list':
      list(loadEnv(), parseArgs(rest, ['long']).flags.long === true);
      return;
    case 'status':
      status(loadEnv());
      return;
    case 'remove': {
      const a = parseArgs(rest, ['yes']);
      const appId = a.positional[0];
      if (!appId) throw new CliError('用法: remove <appId> [--yes]');
      await remove(loadEnv(), appId, a.flags.yes === true);
      requestReload();
      return;
    }
    case 'admin': {
      const [sub, appId, who] = rest;
      if (sub === 'list' && appId) return adminList(loadEnv(), appId);
      if ((sub === 'add' || sub === 'remove') && appId && who) {
        const changed = sub === 'add' ? await adminAdd(loadEnv(), appId, who) : await adminRemove(loadEnv(), appId, who);
        if (changed) requestReload();
        return;
      }
      throw new CliError('用法: admin add|remove <appId> <union_id|邮箱|手机号> / admin list <appId>');
    }
    case 'allow': {
      const a = parseArgs(rest, ['yes']);
      const [sub, appId, arg3] = a.positional;
      if (sub === 'list' && appId) return allowList(loadEnv(), appId);
      if ((sub === 'add' || sub === 'remove') && appId && arg3) {
        const changed = sub === 'add' ? await allowAdd(loadEnv(), appId, arg3) : await allowRemove(loadEnv(), appId, arg3);
        if (changed) requestReload();
        return;
      }
      if (sub === 'all' && appId && (arg3 === 'on' || arg3 === 'off')) {
        if (await allowAll(loadEnv(), appId, arg3 === 'on', a.flags.yes === true)) requestReload();
        return;
      }
      throw new CliError('用法: allow add|remove <appId> <union_id|邮箱|手机号> / allow list <appId> / allow all <appId> on|off [--yes]');
    }
    case 'usage': {
      const a = parseArgs(rest, ['markdown']);
      const days = Math.min(Math.max(Number.parseInt(flagStr(a, 'days') ?? '7', 10) || 7, 1), 90);
      const { openDb } = await import('./store/sqlite.ts');
      const { usageMarkdown, usageStats, usageText } = await import('./store/usage.ts');
      const render = a.flags.markdown === true ? usageMarkdown : usageText;
      const { fmtTokens } = await import('./render/cards.ts');
      const env = loadEnv();
      const db = openDb(paths.dataDb());
      for (const b of env.file.bots.filter((x) => !a.positional[0] || x.appId === a.positional[0])) {
        out(`== ${b.appId}  ${b.appName}`);
        out(render(usageStats(db, { appId: b.appId, sinceMs: Date.now() - days * 86_400_000 }), days, fmtTokens));
        out('');
      }
      db.close();
      return;
    }
    case 'restart':
      out(isDev() ? '（开发模式）请重启 npm run dev。' : '请用包装脚本运行：agentcore-chat-bridge restart（sudo systemctl restart agentcore-feishu-bot，服务名不变）');
      return;
    case 'logs':
      out(isDev() ? '（开发模式）日志直接输出在 npm run dev 的终端。' : `tail -F ${paths.serveLog()}`);
      return;
    case 'update':
      out('update 以 root 运行，请用包装脚本：agentcore-chat-bridge update');
      return;
    case 'rotate-secret': {
      const { rotateSecret } = await import('./cli/rotate.ts');
      const a = parseArgs(rest, ['apply']);
      const r = await rotateSecret(loadEnv(), a.flags.apply === true);
      if (r) {
        if (r.failed) process.exitCode = 1;
        // Make the service switch to the new secret (reload the secret as soon as any user succeeded)
        if (r.ok > 0 || r.total === 0) requestReload();
      }
      return;
    }
    case 'init-config': {
      // Local development: generate an empty bots.json (on the host it is generated by user data)
      const a = parseArgs(rest, []);
      const userPoolId = flagStr(a, 'user-pool-id');
      const hmacSecretArn = flagStr(a, 'hmac-secret-arn');
      if (!userPoolId || !hmacSecretArn) throw new CliError('用法: init-config --user-pool-id <id> --hmac-secret-arn <arn> [--region r]');
      const p = paths.botsJson();
      if (existsSync(p)) throw new CliError(`${p} 已存在，不覆盖`);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeBotsFileAtomic(p, emptyBotsFile({ userPoolId, hmacSecretArn, ...(flagStr(a, 'region') ? { region: flagStr(a, 'region') } : {}) }));
      out(`已生成 ${p}`);
      return;
    }
    case 'version':
    case '--version':
      out(VERSION);
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return;
    default:
      throw new CliError(`未知命令 ${cmd}\n\n${USAGE}`);
  }
}

// Exit quietly, without printing a stack trace, when the output is closed early by something like `| head`
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof CliError || e instanceof ConfigError) {
    process.stderr.write(`错误：${e.message}\n`);
    process.exit(1);
  }
  logger('main').error('未处理的错误', { err: e });
  process.stderr.write(`错误：${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
