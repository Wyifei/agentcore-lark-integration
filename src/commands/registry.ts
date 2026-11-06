// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Slash commands (design 8): one table registers name, aliases, permission, whether an existing session is needed, and help text.
 * /stop (design 7.4) and commands aimed at a local CLI are not implemented.
 */
import type { AgentBinding, BotConfig } from '../config/bots-store.ts';
import type { Role } from '../lark/access.ts';
import type { AgentSession, ConversationInfo, Session, StoredPrompt } from '../session/store.ts';
import { fmtElapsed, fmtTokens } from '../render/cards.ts';

export interface CommandContext {
  bot: BotConfig;
  role: Role;
  /** The current conversation location; commands with needsSession are guaranteed to have one */
  session: Session | undefined;
  /** The current agent's conversation here (undefined when never used) */
  agentSession: AgentSession | undefined;
  /** The binding the current session is using */
  binding: AgentBinding | undefined;
  queueLength: number;
  busy: boolean;
  reply(markdown: string, title?: string): Promise<void>;
  /** /new: increment the current agent's epoch and discard queued messages */
  newSession(): Promise<void>;
  /** /agent: switch agents and continue its last conversation here; resumed means it was used before */
  switchAgent(alias: string): Promise<{ resumed: boolean }>;
  /** /schedule: manage scheduled tasks at this conversation location (design 8.3) */
  schedules: {
    add(text: string): { ok: true; desc: string; next: number } | { ok: false; error: string };
    list(): { desc: string; next: number; prompt: string }[];
    remove(index: number): boolean;
  };
  /** /newbot: register a new bot (design 4.8); direct messages only */
  newBot(name: string): Promise<{ ok: true } | { ok: false; error: string }>;
  isP2p: boolean;
  /** Time zone used to display times */
  timeZone: string;
  /** /usage: this bot's usage over the last N days (markdown) */
  usage(days: number): string;
  /** /resume: the current agent's recent conversations here */
  listConversations(): ConversationInfo[];
  /** /resume <number>: switch back to a conversation */
  resumeConversation(epoch: number): Promise<boolean>;
  /** /retry: put the last message back into the queue */
  resubmit(prompt: StoredPrompt): Promise<void>;
}

export interface CommandDef {
  name: string;
  aliases: string[];
  adminOnly: boolean;
  needsSession: boolean;
  help: string;
  run(ctx: CommandContext, args: string[]): Promise<void>;
}

function readyAgents(bot: BotConfig): AgentBinding[] {
  return bot.agents.filter((a) => a.status === 'ready');
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'new',
    aliases: ['reset', 'clear'],
    adminOnly: false,
    needsSession: false,
    help: '和当前智能体开始新对话（上下文不带过去，排队中的消息丢弃）',
    async run(ctx) {
      if (!ctx.session || !ctx.binding) {
        await ctx.reply('已开始新对话。');
        return;
      }
      await ctx.newSession();
      const who = ctx.bot.agents.length > 1 ? `和 **${ctx.binding.alias}** ` : '';
      await ctx.reply(`已${who}开始新对话。${ctx.busy ? '正在进行的这一轮会照常完成。' : ''}`);
    },
  },
  {
    name: 'status',
    aliases: [],
    adminOnly: false,
    needsSession: false,
    help: '查看当前智能体、会话和用量',
    async run(ctx) {
      const b = ctx.binding;
      const lines: string[] = [];
      if (b) {
        lines.push(`**智能体** ${b.alias}${b.status !== 'ready' ? '（待配置）' : ''}`);
        lines.push(`**Runtime** \`${b.runtimeArn}\``);
        lines.push(`**Endpoint** ${b.qualifier}`);
      } else {
        lines.push('**智能体** 未绑定');
      }
      const s = ctx.agentSession;
      if (s) {
        lines.push(`**会话 ID** \`${s.runtimeSessionId}\``);
        lines.push(
          `**本会话** ${s.usage.turns} 轮 · 输入 ${fmtTokens(s.usage.inputTokens)} · 输出 ${fmtTokens(s.usage.outputTokens)}`,
        );
        if (s.lastTurnMs !== null) lines.push(`**上一轮耗时** ${fmtElapsed(s.lastTurnMs)}`);
      } else {
        lines.push('**会话** 尚未开始');
      }
      lines.push(`**队列** ${ctx.busy ? '执行中' : '空闲'}${ctx.queueLength ? `，排队 ${ctx.queueLength} 条` : ''}`);
      await ctx.reply(lines.join('\n'), '状态');
    },
  },
  {
    name: 'retry',
    aliases: [],
    adminOnly: false,
    needsSession: true,
    help: '重发本会话上一条消息',
    async run(ctx) {
      if (ctx.bot.storePromptText === false) {
        await ctx.reply('这个机器人关闭了 /retry（不保存上一条消息）。');
        return;
      }
      const p = ctx.session?.lastPrompt;
      if (!p) {
        await ctx.reply('本会话还没有可以重发的消息。');
        return;
      }
      await ctx.resubmit(p);
    },
  },
  {
    name: 'agent',
    aliases: ['agents'],
    adminOnly: true,
    needsSession: false,
    help: '列出可用的智能体；`/agent <别名>` 切换（接着它上次的对话）',
    async run(ctx, args) {
      const ready = readyAgents(ctx.bot);
      const current = ctx.binding?.alias;
      if (!args.length) {
        if (!ready.length) {
          await ctx.reply('没有可用的智能体。请管理员在主机上运行 `agentcore-chat-bridge bind` 并完成 `bind --verify`。');
          return;
        }
        const lines = ready.map((a) => `- **${a.alias}**${a.alias === current ? '（当前）' : ''} \`${a.runtimeArn}\` · ${a.qualifier}`);
        await ctx.reply(lines.join('\n') + '\n\n用 `/agent <别名>` 切换。新增智能体只能在主机上用 `bind`。', '可用的智能体');
        return;
      }
      const alias = args[0]!;
      const target = ctx.bot.agents.find((a) => a.alias === alias);
      if (!target) {
        await ctx.reply(`没有别名为 ${alias} 的智能体。`);
        return;
      }
      if (target.status !== 'ready') {
        await ctx.reply(`智能体 ${alias} 还没有通过校验，请先在主机上运行 \`bind --verify\`。`);
        return;
      }
      if (alias === current) {
        await ctx.reply(`当前已经是 **${alias}**。要开始新对话请发 /new。`);
        return;
      }
      const { resumed } = await ctx.switchAgent(alias);
      await ctx.reply(`已切换到 **${alias}**，${resumed ? '继续上次的对话' : '开始新对话'}。`);
    },
  },
  {
    name: 'resume',
    aliases: ['history'],
    adminOnly: false,
    needsSession: false,
    help: '列出最近的对话；`/resume <编号>` 切回那段对话',
    async run(ctx, args) {
      if (!ctx.binding) {
        await ctx.reply('还没有可用的智能体。');
        return;
      }
      const list = ctx.listConversations();
      const cur = ctx.agentSession?.epoch;
      if (!args.length) {
        if (!list.length) {
          await ctx.reply('还没有可以切回的对话。');
          return;
        }
        const fmt = (ms: number) =>
          new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const lines = list.map(
          (c, i) => `${i + 1}. ${fmt(c.startedAt)} · ${c.turns} 轮${c.title ? ` · ${c.title}` : ''}${c.epoch === cur ? '（当前）' : ''}`,
        );
        const who = ctx.bot.agents.length > 1 ? `**${ctx.binding.alias}** 的` : '';
        await ctx.reply(`${who}最近的对话：\n${lines.join('\n')}\n\n发 \`/resume <编号>\` 切回。超过 30 天的对话不再列出。`, '对话记录');
        return;
      }
      const n = Number.parseInt(args[0]!, 10);
      const target = list[n - 1];
      if (!target) {
        await ctx.reply(`没有编号 ${args[0]} 的对话，发 /resume 查看列表。`);
        return;
      }
      if (target.epoch === cur) {
        await ctx.reply('这就是当前的对话。');
        return;
      }
      await ctx.resumeConversation(target.epoch);
      await ctx.reply(`已切回${target.title ? `「${target.title}」` : '这段对话'}，可以接着聊了。`);
    },
  },
  {
    name: 'schedule',
    aliases: ['cron'],
    adminOnly: true,
    needsSession: false,
    help: '定时任务：`/schedule add 每天 09:00 <消息>` / `list` / `remove <编号>`',
    async run(ctx, args) {
      const fmt = (ms: number) =>
        new Date(ms).toLocaleString('zh-CN', { timeZone: ctx.timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      const sub = args[0] ?? 'list';
      if (sub === 'add') {
        const r = ctx.schedules.add(args.slice(1).join(' '));
        await ctx.reply(r.ok ? `已添加：${r.desc}，下次执行 ${fmt(r.next)}（${ctx.timeZone}）。` : r.error);
        return;
      }
      if (sub === 'remove' || sub === 'rm') {
        const n = Number.parseInt(args[1] ?? '', 10);
        await ctx.reply(ctx.schedules.remove(n) ? `已删除第 ${n} 个定时任务。` : '编号不对，发 /schedule list 查看。');
        return;
      }
      const list = ctx.schedules.list();
      if (!list.length) {
        await ctx.reply('这里还没有定时任务。例如：`/schedule add 工作日 09:00 总结一下昨天的新闻`');
        return;
      }
      const lines = list.map((s, i) => `${i + 1}. ${s.desc} · 下次 ${fmt(s.next)} · ${[...s.prompt].slice(0, 20).join('')}`);
      await ctx.reply(lines.join('\n') + '\n\n`/schedule remove <编号>` 删除。', '定时任务');
    },
  },
  {
    name: 'newbot',
    aliases: [],
    adminOnly: true,
    needsSession: false,
    help: '注册一个新机器人（只能在私聊里用），沿用当前的智能体',
    async run(ctx, args) {
      if (!ctx.isP2p) {
        await ctx.reply('请在和我的私聊里使用 /newbot（授权链接只发给你本人）。');
        return;
      }
      const name = args.join(' ').trim() || `${ctx.bot.appName || 'AgentCore'} 2`;
      const r = await ctx.newBot(name.slice(0, 30));
      if (!r.ok) await ctx.reply(r.error);
    },
  },
  {
    name: 'usage',
    aliases: ['stats'],
    adminOnly: true,
    needsSession: false,
    help: '本机器人最近的用量（`/usage <天数>`，默认 7 天）',
    async run(ctx, args) {
      const n = args[0] ? Number.parseInt(args[0], 10) : 7;
      const days = Number.isFinite(n) ? Math.min(Math.max(n, 1), 90) : 7;
      await ctx.reply(ctx.usage(days), '用量统计');
    },
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    adminOnly: false,
    needsSession: false,
    help: '列出命令',
    async run(ctx) {
      const lines = COMMANDS.filter((c) => !c.adminOnly || ctx.role === 'admin').map(
        (c) => `- \`/${c.name}\`${c.adminOnly ? '（管理员）' : ''} ${c.help}`,
      );
      await ctx.reply(lines.join('\n') + '\n\n直接发消息即可和智能体对话。', '命令');
    },
  },
];

const INDEX = new Map<string, CommandDef>();
for (const c of COMMANDS) for (const n of [c.name, ...c.aliases]) INDEX.set(n, c);

export interface ParsedCommand {
  def: CommandDef | undefined;
  name: string;
  args: string[];
}

/** Only text that starts with / is a command; an unknown command returns def undefined */
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  if (!t.startsWith('/') || t.startsWith('//')) return null;
  const [head, ...args] = t.slice(1).split(/\s+/);
  const name = (head ?? '').toLowerCase();
  if (!name) return null;
  return { def: INDEX.get(name), name, args };
}

export type RouteResult = { ok: true } | { ok: false; reason: 'unknown' | 'forbidden' | 'no_session' };

export async function runCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<RouteResult> {
  if (!cmd.def) {
    await ctx.reply(`未知命令 /${cmd.name}，发 /help 查看可用命令。`);
    return { ok: false, reason: 'unknown' };
  }
  if (cmd.def.adminOnly && ctx.role !== 'admin') {
    await ctx.reply('只有管理员可以使用这个命令。');
    return { ok: false, reason: 'forbidden' };
  }
  if (cmd.def.needsSession && !ctx.session) {
    await ctx.reply('本会话还没有开始。');
    return { ok: false, reason: 'no_session' };
  }
  await cmd.def.run(ctx, cmd.args);
  return { ok: true };
}
