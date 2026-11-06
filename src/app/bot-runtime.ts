// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Event handling of one bot (design 5, 8):
 *   event → de-duplicate → parse → authorize → command or chat → session queue → one turn
 */
import { findAgent, type AgentBinding, type BotConfig } from '../config/bots-store.ts';
import { userKeyOf, MissingIdentityError } from '../identity/user-key.ts';
import type { TokenProvider } from '../identity/token-provider.ts';
import type { LarkApi, ReplyTarget } from '../lark/api.ts';
import { NO_PERMISSION_TEXT, roleOf, type Role } from '../lark/access.ts';
import {
  expandForward,
  messageShape,
  isBotMentioned,
  parseContent,
  unwrapReceive,
  withQuote,
  type ParsedContent,
  type ReceiveEvent,
} from '../lark/message-parser.ts';
import { replyTargetFor } from '../lark/reply-target.ts';
import { buildNoticeCard, buildQueuedCard } from '../render/cards.ts';
import { anchorOf, sessionKeyOf } from '../session/keys.ts';
import type { SessionQueues } from '../session/queue.ts';
import type { Session, SessionStore, StoredPrompt } from '../session/store.ts';
import type { SeenEvents } from '../store/seen-events.ts';
import { parseCommand, runCommand, type CommandContext } from '../commands/registry.ts';
import { runTurn, type TurnDeps } from './turn.ts';
import type { FetchLike } from '../agentcore/invoke.ts';
import { logger } from '../util/log.ts';
import { randomUUID } from 'node:crypto';
import { describeSpec, nextRun, parseSpec, SpecError, type Schedule, type ScheduleStore } from '../session/schedule.ts';
import type { Db } from '../store/sqlite.ts';
import { usageMarkdown, usageStats } from '../store/usage.ts';
import { fmtTokens } from '../render/cards.ts';

const log = logger('bot');

export interface NewBotRequest {
  fromAppId: string;
  adminUnionId: string;
  name: string;
  binding: AgentBinding;
  /** Send a card to the initiator (authorization link, result) */
  notify(card: object): Promise<void>;
}

export interface SharedDeps {
  db: Db;
  /** /newbot (design 4.8), implemented by the service */
  newBot?: (req: NewBotRequest) => Promise<void>;
  schedules: ScheduleStore;
  /** Change a bot's configuration and make the service reload (used by "allow" on the access-request card, design 5.2.1) */
  mutateBot?: (appId: string, fn: (bot: BotConfig) => void) => Promise<void>;
  sessions: SessionStore;
  seen: SeenEvents;
  queues: SessionQueues;
  tokens: TokenProvider;
  fetchImpl?: FetchLike;
  streamMinIntervalMs?: number;
}

/** Context of one chat request (a message or the "Regenerate" button) */
interface Origin {
  bot: BotConfig;
  userKey: string;
  unionId: string;
  role: Role;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId?: string;
  messageId: string;
  target: ReplyTarget;
  sessionKey: string;
}

export const USER_NAME_TTL_MS = 24 * 3600 * 1000;

export class BotRuntime {
  readonly appId: string;
  private newBotRunning = false;
  /** union_id → display name, in memory only (design 6.1.1) */
  private readonly names = new Map<string, { name: string | undefined; at: number }>();
  private bot: BotConfig;
  private readonly api: LarkApi;
  private readonly deps: SharedDeps;

  constructor(bot: BotConfig, api: LarkApi, deps: SharedDeps) {
    this.appId = bot.appId;
    this.bot = bot;
    this.api = api;
    this.deps = deps;
  }

  /** Switch to the new configuration after SIGHUP; turns in progress are not affected */
  updateConfig(bot: BotConfig): void {
    this.bot = bot;
  }

  get config(): BotConfig {
    return this.bot;
  }

  // ---------------- Messages ----------------

  async handleMessage(data: unknown): Promise<void> {
    const { eventId, tenantKey, sender, message } = unwrapReceive(data as ReceiveEvent);
    if (!message) return;
    if (!this.deps.seen.markFirstSeen(eventId ?? `msg:${message.message_id}`)) {
      log.debug('重复事件，丢弃', { appId: this.appId });
      return;
    }
    if (sender?.sender_type && sender.sender_type !== 'user') return;
    const bot = this.bot;

    let botOpenId: string | undefined;
    try {
      botOpenId = await this.api.botOpenId();
    } catch (e) {
      log.warn('获取机器人 open_id 失败', { appId: this.appId, err: e });
    }
    const chatType = message.chat_type === 'p2p' ? 'p2p' : 'group';
    if (chatType === 'group') {
      // In group chats respond only to @-mentions of the bot. If its own open_id is unavailable it cannot tell, so it prefers not to respond
      if (!botOpenId || !isBotMentioned(message, botOpenId)) return;
    }

    const unionId = sender?.sender_id?.union_id;
    let userKey: string;
    try {
      userKey = userKeyOf(tenantKey, unionId);
    } catch (e) {
      if (e instanceof MissingIdentityError) {
        log.warn('发送人身份不完整，拒绝处理', { appId: this.appId, reason: e.message });
        return;
      }
      throw e;
    }

    const threadId = message.thread_id || undefined;
    const target = replyTargetFor({ messageId: message.message_id, chatId: message.chat_id, chatType, threadId });
    const role = roleOf(bot, unionId!);
    let parsed = parseContent(message, botOpenId);
    log.info('收到消息', {
      appId: this.appId,
      chatType,
      ...messageShape(message),
      imageCount: parsed.images.length,
      fileCount: parsed.files?.length ?? 0,
      hasParent: !!message.parent_id,
    });
    const cmd = parseCommand(parsed.text);

    if (role === 'none' && cmd?.def?.name !== 'help') {
      if (bot.accessRequests === false) await this.safeReply(target, NO_PERMISSION_TEXT);
      else await this.requestAccess(unionId!, chatType, target);
      return;
    }

    const origin: Origin = {
      bot,
      userKey,
      unionId: unionId!,
      role,
      chatId: message.chat_id,
      chatType,
      threadId,
      messageId: message.message_id,
      target,
      sessionKey: sessionKeyOf(bot.appId, anchorOf(message.chat_id, threadId), userKey),
    };

    if (cmd) {
      await runCommand(cmd, this.commandContext(origin));
      return;
    }

    if (parsed.mergeForward) {
      try {
        parsed = expandForward(parsed.mergeForward, await this.api.getForwardItems(parsed.mergeForward), botOpenId);
      } catch (e) {
        log.warn('读取合并转发失败', { appId: this.appId, err: e });
        await this.safeReply(target, '读取合并转发的聊天记录失败，请稍后再试。');
        return;
      }
    }
    if (message.parent_id) parsed = withQuote(parsed, await this.quoted(message.parent_id, botOpenId));
    if (parsed.unsupported && !parsed.text && !parsed.images.length && !parsed.files?.length) {
      log.info('不支持的消息类型', { appId: this.appId, messageType: parsed.unsupported });
      await this.safeReply(target, '暂不支持这类消息（合并转发、语音等），请发文字、图片或文件。');
      return;
    }
    if (!parsed.text && !parsed.images.length && !parsed.files?.length) return;
    await this.submit(origin, toStored(parsed));
  }

  private async quoted(parentId: string, botOpenId: string | undefined): Promise<ParsedContent | null> {
    const m = await this.api.getMessage(parentId);
    if (!m) return null;
    const p = parseContent(m, botOpenId);
    return p.unsupported ? null : p;
  }

  // ---------------- Card callbacks ----------------

  /** Must return within 2.5 seconds: answer first, then run asynchronously (design 7.5) */
  handleCardAction(data: unknown): unknown {
    const d = data as {
      event_id?: string;
      operator?: { union_id?: string; tenant_key?: string };
      tenant_key?: string;
      action?: { value?: Record<string, unknown> };
    };
    const v = d.action?.value ?? {};
    if (v.a === 'resume') return this.handleResume(d as never);
    if (v.a === 'access') return this.handleAccess(d as never);
    if (v.a !== 'retry') return {};
    if (d.event_id && !this.deps.seen.markFirstSeen(d.event_id)) return {};
    const unionId = d.operator?.union_id;
    if (!unionId || unionId !== v.u) return toast('warning', '只有提问人可以重新生成');
    let userKey: string;
    try {
      userKey = userKeyOf(d.operator?.tenant_key ?? d.tenant_key, unionId);
    } catch {
      return toast('error', '无法识别你的身份');
    }
    const role = roleOf(this.bot, unionId);
    if (role === 'none') return toast('warning', NO_PERMISSION_TEXT);
    const chatId = String(v.c ?? '');
    const threadId = typeof v.t === 'string' && v.t ? v.t : undefined;
    const chatType = v.ct === 'p2p' ? 'p2p' : 'group';
    const messageId = String(v.m ?? '');
    if (!chatId || !messageId) return {};
    const origin: Origin = {
      bot: this.bot,
      userKey,
      unionId,
      role,
      chatId,
      chatType,
      threadId,
      messageId,
      target: replyTargetFor({ messageId, chatId, chatType, threadId }),
      sessionKey: sessionKeyOf(this.bot.appId, anchorOf(chatId, threadId), userKey),
    };
    const session = this.deps.sessions.get(origin.sessionKey);
    const prompt = session?.lastPrompt;
    if (!prompt || this.bot.storePromptText === false) return toast('warning', '没有可以重发的消息');
    void this.submit(origin, prompt).catch((e) => log.error('重新生成失败', { appId: this.appId, err: e }));
    return toast('success', '已重新提交');
  }

  /**
   * Confirmation button (design 6.5): only the asker can click; the conversation location, agent, and epoch are still current; not expired; one interrupt is accepted only once.
   * Answer first, then disable the buttons asynchronously and start the resume call.
   */
  private handleResume(d: {
    operator?: { union_id?: string; tenant_key?: string };
    tenant_key?: string;
    context?: { open_message_id?: string };
    action?: { value?: Record<string, unknown> };
  }): unknown {
    const v = d.action?.value ?? {};
    const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
    const unionId = d.operator?.union_id;
    if (!unionId || unionId !== s('u')) return toast('warning', '只有提问人可以确认');
    if (Number(s('exp')) * 1000 < Date.now()) return toast('warning', '确认已过期，请重新发起');
    let userKey: string;
    try {
      userKey = userKeyOf(d.operator?.tenant_key ?? d.tenant_key, unionId);
    } catch {
      return toast('error', '无法识别你的身份');
    }
    const role = roleOf(this.bot, unionId);
    if (role === 'none') return toast('warning', NO_PERMISSION_TEXT);
    const chatId = s('c');
    const threadId = s('t') || undefined;
    const chatType = s('ct') === 'p2p' ? 'p2p' : 'group';
    const messageId = s('m');
    const sessionKey = sessionKeyOf(this.bot.appId, anchorOf(chatId, threadId), userKey);
    const session = this.deps.sessions.get(sessionKey);
    const binding = this.bindingFor(this.bot, session);
    if (!session || !binding || binding.alias !== s('al')) return toast('warning', '已切换智能体，这个确认已失效');
    const cur = this.deps.sessions.peekAgentSession(sessionKey, binding.alias);
    if (!cur || String(cur.epoch) !== s('ep')) return toast('warning', '已开始新对话，这个确认已失效');
    if (!this.deps.seen.markFirstSeen(`resume:${s('iid')}`)) return toast('info', '已经处理过了');
    const origin: Origin = {
      bot: this.bot, userKey, unionId, role, chatId, chatType, threadId, messageId,
      target: replyTargetFor({ messageId, chatId, chatType, threadId }),
      sessionKey,
    };
    const cardMessageId = d.context?.open_message_id;
    void (async () => {
      if (cardMessageId) await this.disableButtons(cardMessageId, s('l')).catch((e) => log.warn('禁用确认按钮失败', { err: e }));
      await this.submit(origin, { text: '', images: [] }, { interruptId: s('iid'), value: s('v'), label: s('l') });
    })().catch((e) => log.error('恢复调用失败', { appId: this.appId, err: e }));
    return toast('success', `已选择：${s('l')}`);
  }

  // ---------------- Scheduled tasks (design 8.3) ----------------

  /** Run when due: enter that conversation's queue as if the creator had sent the message. Disable the task when the creator is no longer an administrator */
  async runScheduled(s: Schedule): Promise<void> {
    if (!this.bot.admins.includes(s.unionId)) {
      this.deps.schedules.disable(s.id);
      log.info('定时任务创建者已不是管理员，停用', { appId: this.appId, scheduleId: s.id });
      return;
    }
    const userKey = userKeyOf(s.tenantKey, s.unionId);
    const target: ReplyTarget = s.threadId
      ? { kind: 'reply', messageId: s.sourceMessageId, inThread: true }
      : { kind: 'chat', chatId: s.chatId };
    const origin: Origin = {
      bot: this.bot, userKey, unionId: s.unionId, role: 'admin', chatId: s.chatId, chatType: s.chatType,
      threadId: s.threadId ?? undefined, messageId: s.sourceMessageId, target, sessionKey: s.sessionKey,
    };
    log.info('执行定时任务', { appId: this.appId, scheduleId: s.id, sessionKey: s.sessionKey });
    await this.submit(origin, { text: s.prompt, images: [] }, undefined, '⏰ 定时任务');
  }

  // ---------------- Access requests from strangers (design 5.2.1) ----------------

  private async requestAccess(unionId: string, chatType: 'p2p' | 'group', target: ReplyTarget): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    if (!this.deps.seen.markFirstSeen(`apply:${this.appId}:${unionId}:${day}`)) {
      await this.safeReply(target, '申请已发送，请等待管理员处理。');
      return;
    }
    await this.safeReply(target, `${NO_PERMISSION_TEXT.replace('请联系管理员添加。', '')}已向管理员发送申请，通过后会通知你。`);
    const name = (await this.userName(unionId)) ?? '某位同事';
    const rid = randomUUID();
    const when = new Date().toLocaleString('zh-CN', { timeZone: this.bot.timezone ?? 'Asia/Shanghai', hour12: false });
    const btn = (act: 'allow' | 'deny', label: string, type: string) => ({
      tag: 'button',
      element_id: `btn_acc_${act}`,
      text: { tag: 'plain_text', content: label },
      type,
      size: 'small',
      behaviors: [{ type: 'callback', value: { a: 'access', act, au: unionId, rid, n: name.slice(0, 30) } }],
    });
    const card = {
      schema: '2.0',
      config: { update_multi: true, summary: { content: `${name} 申请使用 ${this.bot.appName}` } },
      header: { title: { tag: 'plain_text', content: '使用申请' }, template: 'blue' },
      body: {
        elements: [
          { tag: 'markdown', content: `**${name}** 申请使用 **${this.bot.appName}**\n<font color='grey'>来源：${chatType === 'p2p' ? '私聊' : '群聊'} · ${when}</font>` },
          {
            tag: 'column_set',
            flex_mode: 'none',
            horizontal_spacing: '8px',
            columns: [btn('allow', '允许', 'primary'), btn('deny', '拒绝', 'default')].map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
          },
        ],
      },
    };
    for (const admin of this.bot.admins) {
      await this.api.sendCard({ kind: 'user', unionId: admin }, card).catch((e) => log.warn('发送申请卡片失败', { appId: this.appId, err: e }));
    }
  }

  private handleAccess(d: {
    operator?: { union_id?: string };
    context?: { open_message_id?: string };
    action?: { value?: Record<string, unknown> };
  }): unknown {
    const v = d.action?.value ?? {};
    const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
    const op = d.operator?.union_id;
    if (!op || !this.bot.admins.includes(op)) return toast('warning', '只有管理员可以处理申请');
    const applicant = s('au');
    if (!applicant.startsWith('on_')) return {};
    if (!this.deps.seen.markFirstSeen(`access:${s('rid')}`)) return toast('info', '这个申请已经处理过了');
    const allow = s('act') === 'allow';
    const msgId = d.context?.open_message_id;
    void (async () => {
      if (allow) {
        if (!this.deps.mutateBot) throw new Error('不支持修改配置');
        await this.deps.mutateBot(this.appId, (b) => {
          if (!b.allowedUsers.includes(applicant)) b.allowedUsers.push(applicant);
        });
      }
      if (msgId) await this.markCardDone(msgId, ['btn_acc_allow', 'btn_acc_deny'], allow ? '已允许' : '已拒绝').catch(() => {});
      await this.api.sendText(
        { kind: 'user', unionId: applicant },
        allow ? `你使用「${this.bot.appName}」的申请已通过，可以开始对话了（请重新发送刚才的消息）。` : `你使用「${this.bot.appName}」的申请未通过。`,
      );
      log.info('处理使用申请', { appId: this.appId, result: allow ? 'allow' : 'deny' });
    })().catch((e) => log.error('处理使用申请失败', { appId: this.appId, err: e }));
    return toast('success', allow ? `已允许 ${s('n') || '申请人'}` : '已拒绝');
  }

  /** Card that was clicked: disable the buttons and show the result on the first button */
  private async markCardDone(messageId: string, elementIds: string[], label: string): Promise<void> {
    const cardId = await this.api.idConvert(messageId);
    const base = Math.floor(Date.now() / 1000);
    for (const [i, el] of elementIds.entries()) {
      const partial = i === 0 ? { disabled: true, text: { tag: 'plain_text', content: label } } : { disabled: true };
      await this.api.patchElement(cardId, el, partial, base + i).catch(() => {});
    }
  }

  /** Confirmation card that was clicked: disable all buttons and show the selected result on the first button */
  private async disableButtons(messageId: string, label: string): Promise<void> {
    const cardId = await this.api.idConvert(messageId);
    // The sequence used for streaming writes is small; a timestamp in seconds is used here to guarantee it increases monotonically
    const base = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      const partial = i === 0 ? { disabled: true, text: { tag: 'plain_text', content: `已选择：${label}` } } : { disabled: true };
      await this.api.patchElement(cardId, `btn_opt_${i}`, partial, base + i).catch(() => {
        /* With fewer than 5 options, the later elements do not exist */
      });
    }
  }

  // ---------------- Chat ----------------

  private bindingFor(bot: BotConfig, session: Session | undefined): AgentBinding | undefined {
    const alias = session?.agentAlias;
    return (alias ? findAgent(bot, alias) : undefined) ?? findAgent(bot, bot.defaultAgent);
  }

  private async submit(
    o: Origin,
    prompt: StoredPrompt,
    resume?: { interruptId: string; value: string; label: string },
    note?: string,
  ): Promise<void> {
    const bot = this.bot;
    const existing = this.deps.sessions.get(o.sessionKey);
    const binding = this.bindingFor(bot, existing);
    if (!binding || binding.status !== 'ready') {
      // Handle messages only for bindings that are ready (design 9.1)
      await this.safeReply(
        o.target,
        o.role === 'admin'
          ? `智能体${binding ? ` ${binding.alias}` : ''}还没有完成配置。请在主机上按提示配置 runtime，然后运行 \`agentcore-chat-bridge bind --verify ${bot.appId} ${binding?.alias ?? ''}\`。`
          : '机器人还没有配置好，请联系管理员。',
      );
      return;
    }
    this.deps.sessions.getOrCreate({
      sessionKey: o.sessionKey,
      appId: bot.appId,
      chatId: o.chatId,
      threadId: o.threadId ?? null,
      userKey: o.userKey,
    });
    // A resume call is not a user message, so it does not overwrite last_prompt
    if (bot.storePromptText !== false && !resume && !note) this.deps.sessions.setLastPrompt(o.sessionKey, prompt);

    const api = this.api;
    let queuedMsg: Promise<string | undefined> | undefined;
    const turnDeps: TurnDeps = {
      api,
      sessions: this.deps.sessions,
      tokens: this.deps.tokens,
      fetchImpl: this.deps.fetchImpl,
      streamMinIntervalMs: this.deps.streamMinIntervalMs,
    };
    const result = this.deps.queues.enqueue(o.sessionKey, {
      onQueued(position) {
        if (!queuedMsg) {
          queuedMsg = api.sendCard(o.target, buildQueuedCard(position)).catch(() => undefined);
        } else {
          void queuedMsg.then((id) => (id ? api.patchCard(id, buildQueuedCard(position)) : undefined)).catch(() => {});
        }
      },
      onDropped(reason) {
        const card =
          reason === 'shutdown'
            ? buildNoticeCard('未执行，请重发', '服务重启，这条消息没有执行。')
            : buildNoticeCard('已丢弃', '已开始新对话，这条排队中的消息没有执行。');
        void queuedMsg?.then((id) => (id ? api.patchCard(id, card) : undefined)).catch(() => {});
      },
      run: async (signal) => {
        // At the start, resolve the binding again from the latest configuration (a reload may have happened in between)
        const latest = this.bot;
        const b = this.bindingFor(latest, this.deps.sessions.get(o.sessionKey));
        const queuedMessageId = queuedMsg ? await queuedMsg : undefined;
        if (!b || b.status !== 'ready') {
          const card = buildNoticeCard('未执行', '智能体绑定已变更，请重发。');
          if (queuedMessageId) await api.patchCard(queuedMessageId, card).catch(() => {});
          else await api.sendCard(o.target, card).catch(() => {});
          return;
        }
        const userName = await this.userName(o.unionId);
        await runTurn(
          {
            userName,
            resume,
            note,
            storePromptText: latest.storePromptText !== false,
            appId: latest.appId,
            sessionKey: o.sessionKey,
            userKey: o.userKey,
            unionId: o.unionId,
            binding: b,
            prompt,
            target: o.target,
            chat: { chatType: o.chatType, chatId: o.chatId, ...(o.threadId ? { threadId: o.threadId } : {}) },
            sourceMessageId: o.messageId,
            turnTimeoutSec: latest.turnTimeoutSec,
            queuedMessageId,
          },
          turnDeps,
          signal,
        );
      },
    });
    if (result.status === 'full') {
      await this.safeReply(o.target, `前面还有 ${this.deps.queues.maxQueued} 条消息在排队，请稍后再发。`);
    } else if (result.status === 'closed') {
      await this.safeReply(o.target, '服务正在重启，请稍后重发。');
    }
  }

  // ---------------- Commands ----------------

  private commandContext(o: Origin): CommandContext {
    const session = this.deps.sessions.get(o.sessionKey);
    const binding = this.bindingFor(o.bot, session);
    return {
      bot: o.bot,
      role: o.role,
      session,
      agentSession: session && binding ? this.deps.sessions.peekAgentSession(o.sessionKey, binding.alias) : undefined,
      binding,
      queueLength: this.deps.queues.queueLength(o.sessionKey),
      busy: this.deps.queues.isBusy(o.sessionKey),
      reply: async (markdown, title) => {
        if (title) await this.safeCard(o.target, buildNoticeCard(title, markdown, 'blue'));
        else await this.safeReply(o.target, markdown);
      },
      newSession: async () => {
        this.ensureSession(o);
        this.deps.queues.dropPending(o.sessionKey, 'new_session');
        // Keep /retry or the "Regenerate" button on an old card from sending a message of the previous conversation into the new one (design 8)
        this.deps.sessions.setLastPrompt(o.sessionKey, null);
        if (binding) this.deps.sessions.bumpEpoch(o.sessionKey, binding.alias);
      },
      timeZone: o.bot.timezone ?? 'Asia/Shanghai',
      isP2p: o.chatType === 'p2p',
      newBot: async (name) => {
        if (!this.deps.newBot) return { ok: false, error: '这个部署不支持 /newbot。' };
        if (!binding || binding.status !== 'ready') return { ok: false, error: '当前没有可用的智能体，无法沿用。' };
        if (this.newBotRunning) return { ok: false, error: '已有一个 /newbot 正在进行，请先完成或等它过期。' };
        this.newBotRunning = true;
        void this.deps
          .newBot({
            fromAppId: o.bot.appId,
            adminUnionId: o.unionId,
            name,
            binding,
            notify: async (card) => {
              await this.api.sendCard(o.target, card);
            },
          })
          .catch(async (e) => {
            log.error('/newbot 失败', { appId: this.appId, err: e });
            await this.safeReply(o.target, `注册新机器人失败：${(e as { code?: string }).code ?? (e as Error).name}`);
          })
          .finally(() => (this.newBotRunning = false));
        return { ok: true };
      },
      schedules: {
        add: (text) => {
          try {
            const { spec, rest } = parseSpec(text);
            const tz = o.bot.timezone ?? 'Asia/Shanghai';
            const next = nextRun(spec, Date.now(), tz);
            this.deps.schedules.add({
              appId: o.bot.appId, sessionKey: o.sessionKey, unionId: o.unionId, tenantKey: o.userKey.split(':')[1] ?? '',
              chatId: o.chatId, chatType: o.chatType, threadId: o.threadId ?? null, sourceMessageId: o.messageId,
              spec, prompt: rest, nextRunAt: next,
            });
            return { ok: true, desc: describeSpec(spec), next };
          } catch (e) {
            if (e instanceof SpecError) return { ok: false, error: e.message };
            throw e;
          }
        },
        list: () => this.deps.schedules.list(o.sessionKey).map((s) => ({ desc: describeSpec(s.spec), next: s.nextRunAt, prompt: s.prompt })),
        remove: (index) => {
          const s = this.deps.schedules.list(o.sessionKey)[index - 1];
          if (!s) return false;
          this.deps.schedules.remove(s.id);
          return true;
        },
      },
      usage: (days) =>
        usageMarkdown(usageStats(this.deps.db, { appId: o.bot.appId, sinceMs: Date.now() - days * 86_400_000 }), days, fmtTokens),
      listConversations: () => (binding ? this.deps.sessions.listConversations(o.sessionKey, binding.alias) : []),
      resumeConversation: async (epoch) => {
        if (!binding) return false;
        this.ensureSession(o);
        // Same rules as /new: discard queued messages and clear last_prompt (design 8.1)
        this.deps.queues.dropPending(o.sessionKey, 'new_session');
        this.deps.sessions.setLastPrompt(o.sessionKey, null);
        return !!this.deps.sessions.resumeConversation(o.sessionKey, binding.alias, epoch);
      },
      switchAgent: async (alias) => {
        this.ensureSession(o);
        // Queued messages were meant for the original agent, so they are discarded after switching (design 8)
        this.deps.queues.dropPending(o.sessionKey, 'new_session');
        this.deps.sessions.setLastPrompt(o.sessionKey, null);
        return { resumed: this.deps.sessions.switchAgent(o.sessionKey, alias).resumed };
      },
      resubmit: (prompt) => this.submit(o, prompt),
    };
  }

  /** Look up the display name: in-memory cache for 24 hours; a failure does not block the conversation, only the error code is logged, and failed results are not cached */
  private async userName(unionId: string): Promise<string | undefined> {
    const hit = this.names.get(unionId);
    if (hit && Date.now() - hit.at < USER_NAME_TTL_MS) return hit.name;
    try {
      const name = await this.api.userName(unionId);
      this.names.set(unionId, { name, at: Date.now() });
      return name;
    } catch (e) {
      log.warn('查询用户名失败', { appId: this.appId, code: (e as { code?: number }).code });
      return undefined;
    }
  }

  private ensureSession(o: Origin): Session {
    return this.deps.sessions.getOrCreate({
      sessionKey: o.sessionKey,
      appId: o.bot.appId,
      chatId: o.chatId,
      threadId: o.threadId ?? null,
      userKey: o.userKey,
    });
  }

  private async safeReply(target: ReplyTarget, markdown: string): Promise<void> {
    // Send markdown as a card, in the same format as streaming replies
    await this.safeCard(target, { schema: '2.0', body: { elements: [{ tag: 'markdown', content: markdown }] } });
  }

  private async safeCard(target: ReplyTarget, card: object): Promise<void> {
    try {
      await this.api.sendCard(target, card);
    } catch (e) {
      log.warn('发送回复失败', { appId: this.appId, err: e });
    }
  }
}

function toStored(p: ParsedContent): StoredPrompt {
  return { text: p.text, images: p.images, ...(p.files?.length ? { files: p.files } : {}) };
}

function toast(type: 'success' | 'info' | 'warning' | 'error', content: string): unknown {
  return { toast: { type, content } };
}
