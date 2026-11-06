// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * `serve` entry point (design 2, 4.5, 5.5, 10):
 * load configuration → open SQLite → read the HMAC secret → open a long connection per bot → status.json writer;
 * SIGHUP reloads bots.json and the HMAC secret; SIGTERM runs the shutdown flow.
 *
 * The external dependencies of Service (Cognito, Secrets Manager, the Feishu API, long connections) can all be injected, which makes testing easier.
 */
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { readBotsFile, regionOf, updateBotsFile, type BotConfig, type BotsFile } from '../config/bots-store.ts';
import { paths, VERSION } from '../config/paths.ts';
import type { FetchLike } from '../agentcore/invoke.ts';
import { createBindingClient, sdkCognitoApi, type CognitoApi } from '../identity/cognito.ts';
import * as Lark from '@larksuiteoapi/node-sdk';
import { SCOPES } from '../setup/scopes.ts';
import { addBot, type AgentBinding } from '../config/bots-store.ts';
import { HmacKeyStore, secretsManagerFetcher, type SecretFetcher } from '../identity/hmac-secret.ts';
import { TokenProvider } from '../identity/token-provider.ts';
import { newLarkClient, sdkLarkApi, type LarkApi } from '../lark/api.ts';
import { BotConnection, type ConnectionHandlers } from '../lark/connection.ts';
import { SessionQueues } from '../session/queue.ts';
import { SessionStore } from '../session/store.ts';
import { SeenEvents } from '../store/seen-events.ts';
import { openDb, type Db } from '../store/sqlite.ts';
import { StatusWriter, type ConnState } from '../store/status-file.ts';
import { BotRuntime, type NewBotRequest, type SharedDeps } from './bot-runtime.ts';
import { purgeTurns } from '../store/usage.ts';
import { nextRun, ScheduleStore } from '../session/schedule.ts';
import { logger } from '../util/log.ts';

const log = logger('serve');

export const SHUTDOWN_GRACE_MS = 60_000;

/** Minimal interface of a long connection (implemented by BotConnection) */
export interface Connection {
  readonly state: ConnState;
  readonly since: string;
  close(): void;
}

export interface ServiceDeps {
  botsJsonPath: string;
  dbPath: string;
  statusPath: string;
  secretFetcher(file: BotsFile): SecretFetcher;
  cognito(file: BotsFile): CognitoApi;
  larkApi(bot: BotConfig): LarkApi;
  connect(bot: BotConfig, h: ConnectionHandlers): Connection;
  fetchImpl?: FetchLike;
  /** /newbot (design 4.8): registration with the official device code; returns the AppID / AppSecret / open_id of the person who scanned */
  registerApp?: (opts: { name: string; onUrl: (url: string, expireIn: number) => void }) => Promise<{ appId: string; appSecret: string; openId?: string }>;
  /** /newbot: resolve the open_id of the person who scanned into a union_id with the new app */
  unionIdFromOpenId?: (appId: string, appSecret: string, openId: string) => Promise<string | undefined>;
  /** /newbot: create a Cognito app client for the new binding */
  createBindingClient?: (file: BotsFile, name: string) => Promise<string>;
  shutdownGraceMs?: number;
  streamMinIntervalMs?: number;
}

export function productionDeps(): ServiceDeps {
  return {
    botsJsonPath: paths.botsJson(),
    dbPath: paths.dataDb(),
    statusPath: paths.statusJson(),
    secretFetcher: (f) => secretsManagerFetcher(new SecretsManagerClient({ region: regionOf(f.settings) }), f.settings.hmacSecretArn),
    cognito: (f) => sdkCognitoApi(new CognitoIdentityProviderClient({ region: regionOf(f.settings) }), f.settings.userPoolId),
    larkApi: (bot) => sdkLarkApi(newLarkClient(bot.appId, bot.appSecret)),
    connect: (bot, h) => new BotConnection(bot.appId, bot.appSecret, h),
    registerApp: async ({ name, onUrl }) => {
      const r = await Lark.registerApp({
        source: 'agentcore-chat-bridge',
        createOnly: true,
        appPreset: { name, desc: '连接 Amazon Bedrock AgentCore 智能体的飞书机器人' },
        addons: {
          scopes: { tenant: SCOPES.tenant },
          events: { items: { tenant: SCOPES.events } },
          callbacks: { items: SCOPES.callbacks },
        },
        onQRCodeReady: ({ url, expireIn }) => onUrl(url, expireIn),
      });
      return { appId: r.client_id, appSecret: r.client_secret, openId: r.user_info?.open_id };
    },
    unionIdFromOpenId: async (appId, appSecret, openId) => {
      const r = (await newLarkClient(appId, appSecret).request({
        method: 'GET',
        url: `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
        params: { user_id_type: 'open_id' },
      })) as { code?: number; data?: { user?: { union_id?: string } } };
      const u = r.code === 0 ? r.data?.user?.union_id : undefined;
      return u?.startsWith('on_') ? u : undefined;
    },
    createBindingClient: (file, name) =>
      createBindingClient(new CognitoIdentityProviderClient({ region: regionOf(file.settings) }), file.settings.userPoolId, name),
  };
}

interface Running {
  runtime: BotRuntime;
  conn: Connection;
  secret: string;
}

export class Service {
  private readonly deps: ServiceDeps;
  private readonly startedAt = new Date().toISOString();
  private file!: BotsFile;
  private keys!: HmacKeyStore;
  private db!: Db;
  private seen!: SeenEvents;
  private shared!: SharedDeps;
  private status!: StatusWriter;
  readonly queues: SessionQueues;
  readonly running = new Map<string, Running>();
  private reloading: Promise<boolean> | null = null;
  private purgeTimer: NodeJS.Timeout | undefined;
  private scheduleTimer: NodeJS.Timeout | undefined;
  private stopping: Promise<void> | null = null;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.queues = new SessionQueues(5, (key, e) => log.error('一轮执行异常', { sessionKey: key, err: e }));
  }

  async start(): Promise<void> {
    this.file = readBotsFile(this.deps.botsJsonPath);
    this.keys = new HmacKeyStore(this.deps.secretFetcher(this.file));
    await this.keys.reload();
    this.db = openDb(this.deps.dbPath);
    this.seen = new SeenEvents(this.db);
    this.seen.startPurgeTimer();
    this.shared = {
      db: this.db,
      newBot: (req) => this.newBot(req),
      schedules: new ScheduleStore(this.db),
      mutateBot: async (appId, fn) => {
        await updateBotsFile(this.deps.botsJsonPath, (f) => {
          const b = f.bots.find((x) => x.appId === appId);
          if (!b) throw new Error(`没有机器人 ${appId}`);
          fn(b);
          return f;
        });
        await this.reload();
      },
      sessions: new SessionStore(this.db),
      seen: this.seen,
      queues: this.queues,
      tokens: new TokenProvider(this.deps.cognito(this.file), this.keys),
      fetchImpl: this.deps.fetchImpl,
      streamMinIntervalMs: this.deps.streamMinIntervalMs,
    };
    this.status = new StatusWriter(this.deps.statusPath, () => ({
      version: VERSION,
      pid: process.pid,
      startedAt: this.startedAt,
      bots: [...this.running.values()].map(({ runtime, conn }) => {
        const s = this.queues.stats(`${runtime.appId}|`);
        return {
          appId: runtime.appId,
          appName: runtime.config.appName,
          connection: conn.state,
          since: conn.since,
          activeSessions: s.active,
          queuedTurns: s.queued,
        };
      }),
    }));
    this.queues.onChange = () => this.status.changed();
    this.sync(this.file);
    this.status.start();
    // Conversation records past the retention period (design 8.1)
    const purge = () => {
      try {
        this.shared.sessions.purgeConversations();
        purgeTurns(this.db);
      } catch (e) {
        log.warn('清理对话记录失败', { err: e });
      }
    };
    purge();
    this.purgeTimer = setInterval(purge, 3600_000);
    this.purgeTimer.unref();
    this.scheduleTimer = setInterval(() => void this.runDueSchedules(), 30_000);
    this.scheduleTimer.unref();
    log.info('服务已启动', { version: VERSION, bots: this.file.bots.length });
  }

  runtime(appId: string): BotRuntime | undefined {
    return this.running.get(appId)?.runtime;
  }

  private startBot(bot: BotConfig): void {
    const runtime = new BotRuntime(bot, this.deps.larkApi(bot), this.shared);
    const conn = this.deps.connect(bot, {
      onMessage: (d) => runtime.handleMessage(d),
      onCardAction: (d) => runtime.handleCardAction(d),
      onStateChange: () => this.status.changed(),
    });
    this.running.set(bot.appId, { runtime, conn, secret: bot.appSecret });
    log.info('已加载机器人', { appId: bot.appId, agents: bot.agents.length });
  }

  /** Compare by appId: connect new ones, disconnect removed ones, reconnect when the AppSecret changed, and only swap the configuration for the rest (turns in progress are not affected) */
  private sync(next: BotsFile): void {
    const nextIds = new Set(next.bots.map((b) => b.appId));
    for (const [appId, r] of this.running) {
      if (!nextIds.has(appId)) {
        r.conn.close();
        this.running.delete(appId);
        for (const a of r.runtime.config.agents) this.shared.tokens.dropClient(a.clientId);
        log.info('已移除机器人', { appId });
      }
    }
    for (const bot of next.bots) {
      const r = this.running.get(bot.appId);
      if (!r) {
        this.startBot(bot);
      } else if (r.secret !== bot.appSecret) {
        r.conn.close();
        this.running.delete(bot.appId);
        this.startBot(bot);
      } else {
        for (const a of r.runtime.config.agents) {
          if (!bot.agents.some((b) => b.clientId === a.clientId)) this.shared.tokens.dropClient(a.clientId);
        }
        r.runtime.updateConfig(bot);
      }
    }
    this.file = next;
    this.status.changed();
  }

  /**
   * /newbot (design 4.8): official device-code path only. Send the authorization link by direct message to the administrator who started it;
   * when done, write bots.json, bind the initiator's current agent to the new bot (pending), and reload.
   */
  private async newBot(req: NewBotRequest): Promise<void> {
    if (!this.deps.registerApp || !this.deps.createBindingClient) throw new Error('不支持 /newbot');
    const linkCard = (url: string, minutes: number) => ({
      schema: '2.0',
      config: { update_multi: true, summary: { content: `创建机器人：${req.name}` } },
      header: { title: { tag: 'plain_text', content: `创建机器人：${req.name}` }, template: 'blue' },
      body: {
        elements: [
          { tag: 'markdown', content: `点击下面的按钮，在飞书里确认创建（${minutes} 分钟内有效）。\n<font color='grey'>链接只发给你本人，请不要转发。</font>` },
          { tag: 'button', text: { tag: 'plain_text', content: '确认创建' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }] },
        ],
      },
    });
    const reg = await this.deps.registerApp({
      name: req.name,
      onUrl: (url, expireIn) => void req.notify(linkCard(url, Math.max(1, Math.round(expireIn / 60)))).catch(() => {}),
    });
    // Administrator: resolve the open_id of the person who scanned into a union_id with the new app; if that fails reuse the initiator (union_id is the same within one developer entity)
    let admin = req.adminUnionId;
    if (reg.openId && this.deps.unionIdFromOpenId) {
      admin = (await this.deps.unionIdFromOpenId(reg.appId, reg.appSecret, reg.openId).catch(() => undefined)) ?? admin;
    }
    const clientId = await this.deps.createBindingClient(this.file, `afb-${reg.appId}-default`);
    const binding: AgentBinding = {
      alias: 'default',
      runtimeArn: req.binding.runtimeArn,
      qualifier: req.binding.qualifier,
      clientId,
      status: 'pending',
      verifiedAt: null,
    };
    await updateBotsFile(this.deps.botsJsonPath, (f) => {
      addBot(f, {
        appId: reg.appId, appSecret: reg.appSecret, appName: req.name, agents: [binding], defaultAgent: 'default',
        admins: [...new Set([admin, req.adminUnionId])], allowedUsers: [], allowAll: false, turnTimeoutSec: 600,
        storePromptText: true, createdAt: new Date().toISOString(),
      });
      return f;
    });
    await this.reload();
    log.info('/newbot 已创建机器人', { fromAppId: req.fromAppId, appId: reg.appId });
    await req.notify({
      schema: '2.0',
      config: { update_multi: true, summary: { content: `已创建：${req.name}` } },
      header: { title: { tag: 'plain_text', content: `已创建：${req.name}` }, template: 'green' },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: [
              `**AppID** \`${reg.appId}\``,
              `已绑定智能体 \`${binding.runtimeArn}\`（待配置）。`,
              `请把 app client \`${clientId}\` 加进这个 runtime 的 \`allowedClients\`，然后在主机上运行：`,
              `\`agentcore-chat-bridge bind --verify ${reg.appId} default\``,
              '另外请到开放平台确认事件与回调为"长连接"、版本已发布。',
            ].join('\n'),
          },
        ],
      },
    });
  }

  /** Scheduled tasks that are due: compute the next time first, then run (missed runs are not made up, design 8.3) */
  async runDueSchedules(now = Date.now()): Promise<number> {
    let n = 0;
    for (const s of this.shared.schedules.due(now)) {
      const rt = this.running.get(s.appId)?.runtime;
      if (!rt) {
        this.shared.schedules.disable(s.id);
        continue;
      }
      try {
        this.shared.schedules.setNext(s.id, nextRun(s.spec, now, rt.config.timezone ?? 'Asia/Shanghai'));
        await rt.runScheduled(s);
        n++;
      } catch (e) {
        log.error('定时任务执行失败', { scheduleId: s.id, err: e });
      }
    }
    return n;
  }

  /** SIGHUP: re-read bots.json and the HMAC secret. Keep the old configuration when the new one is invalid. Returns whether it succeeded */
  reload(): Promise<boolean> {
    if (this.reloading) return this.reloading;
    this.reloading = (async () => {
      try {
        const next = readBotsFile(this.deps.botsJsonPath);
        if (next.settings.userPoolId !== this.file.settings.userPoolId) log.warn('userPoolId 变化需要重启服务才能生效');
        this.sync(next);
        await this.keys.reload();
        log.info('已重新加载配置', { bots: next.bots.length });
        return true;
      } catch (e) {
        log.error('重新加载失败，继续使用旧配置', { err: e });
        return false;
      } finally {
        this.reloading = null;
      }
    })();
    return this.reloading;
  }

  /** SIGTERM: stop accepting new messages → wait for turns in progress (up to 60 seconds, then interrupt) → mark queued ones "not executed, please resend" */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      for (const r of this.running.values()) r.conn.close();
      await this.queues.shutdown(this.deps.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
      this.status.stop();
      if (this.purgeTimer) clearInterval(this.purgeTimer);
      if (this.scheduleTimer) clearInterval(this.scheduleTimer);
      try {
        this.status.writeNow();
      } catch {
        /* ignore */
      }
      this.seen.stop();
      this.db.close();
      log.info('已停止');
    })();
    return this.stopping;
  }
}

export async function serve(): Promise<void> {
  const svc = new Service(productionDeps());
  // A SIGHUP received during startup must not kill the process through the default behavior
  let started = false;
  process.on('SIGHUP', () => {
    if (started) void svc.reload();
  });
  await svc.start();
  started = true;
  // All other timers are unref'd; keep the process running even with no bots (long connections), to wait for a SIGHUP that loads a new bot
  const keepalive = setInterval(() => {}, 1 << 30);
  const stop = (signal: string) => {
    log.info('收到停止信号，开始停机', { signal });
    clearInterval(keepalive);
    void svc.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
