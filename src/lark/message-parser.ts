// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { logger } from '../util/log.ts';

const log = logger('parser');

/**
 * Message parsing (design 5.1): text, rich text (post), images, files, and quoted replies; merged forwards are handled separately (5.1.1).
 */

export interface Mention {
  key: string;
  id?: { open_id?: string; union_id?: string; user_id?: string } | string;
  name?: string;
}

export interface RawMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  chat_id: string;
  thread_id?: string;
  chat_type: 'p2p' | 'group' | string;
  message_type: string;
  content: string;
  mentions?: Mention[];
}

export interface RawSender {
  sender_id?: { union_id?: string; open_id?: string; user_id?: string };
  sender_type?: string;
  tenant_key?: string;
}

export interface ReceiveEvent {
  event_id?: string;
  tenant_key?: string;
  header?: { event_id?: string; tenant_key?: string };
  sender?: RawSender;
  message?: RawMessage;
  event?: { sender?: RawSender; message?: RawMessage };
}

export interface ImageRef {
  messageId: string;
  imageKey: string;
}

export interface FileRef {
  messageId: string;
  fileKey: string;
  name: string;
}

export interface ParsedContent {
  text: string;
  images: ImageRef[];
  /** File (design 6.4) */
  files?: FileRef[];
  /** Unsupported message type */
  unsupported?: string;
  /** message_id of a merged-forward message, which has to be read once more to expand it (design 5.1.1) */
  mergeForward?: string;
}

/** The SDK's EventDispatcher flattens the header and event fields; both shapes are handled */
export function unwrapReceive(e: ReceiveEvent): {
  eventId: string | undefined;
  tenantKey: string | undefined;
  sender: RawSender | undefined;
  message: RawMessage | undefined;
} {
  const sender = e.sender ?? e.event?.sender;
  return {
    eventId: e.event_id ?? e.header?.event_id,
    tenantKey: sender?.tenant_key ?? e.tenant_key ?? e.header?.tenant_key,
    sender,
    message: e.message ?? e.event?.message,
  };
}

export function mentionOpenId(m: Mention): string | undefined {
  return typeof m.id === 'string' ? m.id : m.id?.open_id;
}

export function isBotMentioned(msg: RawMessage, botOpenId: string): boolean {
  return (msg.mentions ?? []).some((m) => mentionOpenId(m) === botOpenId);
}

/** Message structure (only types and node tags, no content), for troubleshooting problems such as "the attachment was not recognized" */
export function messageShape(msg: RawMessage): { messageType: string; tags?: string[] } {
  if (msg.message_type !== 'post') return { messageType: msg.message_type };
  try {
    const c = JSON.parse(msg.content) as Record<string, unknown>;
    const body = (Array.isArray(c.content) ? c : Object.values(c).find((v) => v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content))) as { content?: unknown[][] } | undefined;
    const tags = new Set<string>();
    for (const para of body?.content ?? []) if (Array.isArray(para)) for (const n of para) tags.add(String((n as { tag?: unknown })?.tag ?? '?'));
    return { messageType: 'post', tags: [...tags] };
  } catch {
    return { messageType: 'post', tags: ['<解析失败>'] };
  }
}

/** @_user_N placeholders in text: remove the bot itself, and replace others with @name */
function replaceMentionKeys(text: string, mentions: Mention[], botOpenId: string | undefined): string {
  let out = text;
  for (const m of mentions) {
    const isBot = botOpenId !== undefined && mentionOpenId(m) === botOpenId;
    out = out.split(m.key).join(isBot ? '' : `@${m.name ?? '用户'}`);
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

interface PostNode {
  tag?: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  image_key?: string;
  file_key?: string;
  file_name?: string;
  language?: string;
  emoji_type?: string;
}

function parsePost(content: unknown, messageId: string, botOpenId: string | undefined): ParsedContent {
  let body = content as { title?: string; content?: PostNode[][] } & Record<string, unknown>;
  // The format of the send API is {zh_cn: {...}}; received events are usually already flattened
  if (!Array.isArray(body?.content)) {
    const firstLocale = Object.values(body ?? {}).find((v) => v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content));
    if (firstLocale) body = firstLocale as typeof body;
  }
  const images: ImageRef[] = [];
  const files: FileRef[] = [];
  const unknownTags = new Set<string>();
  const lines: string[] = [];
  if (body?.title) lines.push(String(body.title));
  for (const para of body?.content ?? []) {
    if (!Array.isArray(para)) continue;
    let line = '';
    for (const n of para) {
      switch (n?.tag) {
        case 'text':
          line += n.text ?? '';
          break;
        case 'a':
          line += n.href ? `[${n.text ?? n.href}](${n.href})` : (n.text ?? '');
          break;
        case 'at':
          if (botOpenId && n.user_id === botOpenId) break;
          line += `@${n.user_name ?? '用户'}`;
          break;
        case 'img':
        case 'image':
          if (n.image_key) images.push({ messageId, imageKey: n.image_key });
          break;
        case 'media':
        case 'file':
          // When rich text contains "text + attachment" together, the attachment is a file / media node (verified in testing: handling only media would lose files)
          if (n.file_key) files.push({ messageId, fileKey: n.file_key, name: n.file_name || (n.tag === 'media' ? 'video.mp4' : 'file') });
          break;
        case 'code_block':
          if (line) {
            lines.push(line);
            line = '';
          }
          lines.push('```' + (n.language ?? '').toLowerCase(), n.text ?? '', '```');
          break;
        case 'md':
          line += n.text ?? '';
          break;
        case 'emotion':
          line += n.emoji_type ? `[${n.emoji_type}]` : '';
          break;
        case 'hr':
          line += '---';
          break;
        default:
          if (n?.file_key) {
            files.push({ messageId, fileKey: n.file_key, name: n.file_name || 'file' });
            break;
          }
          if (n?.tag) unknownTags.add(n.tag);
          if (typeof n?.text === 'string') line += n.text;
      }
    }
    lines.push(line);
  }
  if (unknownTags.size) log.debug('富文本里有未识别的节点', { tags: [...unknownTags] });
  return { text: lines.join('\n').trim(), images, ...(files.length ? { files } : {}) };
}

export function parseContent(msg: RawMessage, botOpenId: string | undefined): ParsedContent {
  let content: unknown;
  try {
    content = JSON.parse(msg.content);
  } catch {
    return { text: '', images: [], unsupported: msg.message_type };
  }
  const c = content as Record<string, unknown>;
  switch (msg.message_type) {
    case 'text':
      return { text: replaceMentionKeys(String(c.text ?? ''), msg.mentions ?? [], botOpenId), images: [] };
    case 'post': {
      const p = parsePost(content, msg.message_id, botOpenId);
      return { ...p, text: replaceMentionKeys(p.text, msg.mentions ?? [], botOpenId) };
    }
    case 'merge_forward':
      return { text: '', images: [], mergeForward: msg.message_id };
    case 'file':
    case 'media':
      return typeof c.file_key === 'string'
        ? {
            text: '',
            images: [],
            files: [{ messageId: msg.message_id, fileKey: c.file_key, name: typeof c.file_name === 'string' && c.file_name ? c.file_name : msg.message_type === 'media' ? 'video.mp4' : 'file' }],
          }
        : { text: '', images: [], unsupported: msg.message_type };
    case 'image':
      return typeof c.image_key === 'string'
        ? { text: '', images: [{ messageId: msg.message_id, imageKey: c.image_key }] }
        : { text: '', images: [], unsupported: 'image' };
    default:
      return { text: '', images: [], unsupported: msg.message_type };
  }
}

/** Child messages of a merged forward (the items of GET /im/v1/messages/{id}) */
export interface ForwardItem extends RawMessage {
  upper_message_id?: string;
  sender_name?: string;
}

export const FORWARD_MAX_ITEMS = 50;
export const FORWARD_MAX_CHARS = 8000;

/** Expand a merged forward (design 5.1.1): child messages are parsed as ordinary messages, and a nested merged forward is not expanded again */
export function expandForward(rootId: string, items: ForwardItem[], botOpenId: string | undefined): ParsedContent {
  const subs = items.filter((it) => it.message_id !== rootId && (it.upper_message_id === rootId || !it.upper_message_id));
  const lines: string[] = [];
  const images: ImageRef[] = [];
  const files: FileRef[] = [];
  let truncated = subs.length > FORWARD_MAX_ITEMS;
  for (const it of subs.slice(0, FORWARD_MAX_ITEMS)) {
    const who = it.sender_name || '某人';
    let body: string;
    if (it.message_type === 'merge_forward') body = '[合并转发]';
    else {
      const p = parseContent(it, botOpenId);
      images.push(...p.images);
      if (p.files) files.push(...p.files);
      body = [p.text, p.images.length ? '[图片]' : '', p.files?.length ? `[文件] ${p.files.map((f) => f.name).join('、')}` : '', p.unsupported ? `[${p.unsupported}]` : '']
        .filter(Boolean)
        .join(' ');
    }
    lines.push(`${who}：${body.replace(/\n/g, '\n  ')}`);
  }
  let text = `[合并转发的聊天记录，共 ${subs.length} 条]\n${lines.join('\n')}`;
  if (text.length > FORWARD_MAX_CHARS) {
    text = text.slice(0, FORWARD_MAX_CHARS);
    truncated = true;
  }
  if (truncated) text += '\n…（聊天记录过长，已截断）';
  return { text, images, ...(files.length ? { files } : {}) };
}

/** Quoted reply: put the text of the quoted message first */
export function withQuote(parsed: ParsedContent, quoted: ParsedContent | null): ParsedContent {
  if (!quoted || (!quoted.text && !quoted.images.length)) return parsed;
  const q = quoted.text
    ? quoted.text
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    : quoted.files?.length
      ? `> [文件] ${quoted.files.map((f) => f.name).join('、')}`
      : '> [图片]';
  const files = [...(quoted.files ?? []), ...(parsed.files ?? [])];
  return {
    text: `${q}\n\n${parsed.text}`.trim(),
    images: [...quoted.images, ...parsed.images],
    ...(files.length ? { files } : {}),
    unsupported: parsed.unsupported,
  };
}
