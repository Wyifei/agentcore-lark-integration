// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * A narrow wrapper around the Feishu OpenAPI: the IM / CardKit / contacts endpoints this project uses.
 * Rendering and orchestration depend only on the LarkApi interface, and tests use a fake.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import type { ForwardItem, RawMessage } from './message-parser.ts';
import { logger } from '../util/log.ts';

/** Reply location (design 5.4) */
export type ReplyTarget =
  | { kind: 'chat'; chatId: string }
  /** Send a direct message to someone by union_id (access-request card, notifications, design 5.2.1) */
  | { kind: 'user'; unionId: string }
  | { kind: 'reply'; messageId: string; inThread: boolean };

export interface LarkApi {
  /** Send a card message; returns the message_id */
  sendCard(target: ReplyTarget, card: object): Promise<string>;
  sendText(target: ReplyTarget, text: string): Promise<string>;
  /** Upload a file and send it as a file message */
  sendFile(target: ReplyTarget, fileName: string, content: Buffer): Promise<string>;
  /** Update an ordinary card with im.message.patch (not CardKit entity streaming writes) */
  patchCard(messageId: string, card: object): Promise<void>;
  idConvert(messageId: string): Promise<string>;
  /** CardKit full update */
  cardUpdate(cardId: string, card: object, sequence: number): Promise<void>;
  /** CardKit streaming update of a text element (full text) */
  elementContent(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  cardSettings(cardId: string, config: object, sequence: number): Promise<void>;
  /** CardKit partial update of one element's properties */
  patchElement(cardId: string, elementId: string, partial: object, sequence: number): Promise<void>;
  downloadImage(messageId: string, imageKey: string): Promise<{ data: Buffer; mimeType: string }>;
  /** Download a file (design 6.4); aborts while reading when it exceeds maxBytes and throws FileTooLargeError */
  downloadFile(messageId: string, fileKey: string, maxBytes: number): Promise<Buffer>;
  botOpenId(): Promise<string>;
  /** Read one message (used for quoted replies); returns null when it cannot be read */
  getMessage(messageId: string): Promise<RawMessage | null>;
  /** Read a merged-forward message and its child messages (design 5.1.1) */
  getForwardItems(messageId: string): Promise<ForwardItem[]>;
  /** Look up the display name by union_id (design 6.1.1); returns undefined when not found */
  userName(unionId: string): Promise<string | undefined>;
}

export class LarkApiError extends Error {
  override name = 'LarkApiError';
  readonly code: number;
  constructor(op: string, code: number, msg: string) {
    super(`${op} 失败: code=${code} ${msg}`);
    this.code = code;
  }
}

interface Res {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

function check(op: string, r: unknown): Record<string, unknown> {
  const res = r as Res;
  if (res && typeof res.code === 'number' && res.code !== 0) throw new LarkApiError(op, res.code, res.msg ?? '');
  return res?.data ?? {};
}

/** The axios error thrown by the SDK carries the Feishu error code */
function rethrow(op: string, e: unknown): never {
  const d = (e as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  if (d && typeof d.code === 'number') throw new LarkApiError(op, d.code, d.msg ?? '');
  throw e;
}

function sniffMime(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

export class FileTooLargeError extends Error {
  override name = 'FileTooLargeError';
}

async function streamToBuffer(s: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of s as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > maxBytes) {
      (s as unknown as { destroy?: () => void }).destroy?.();
      throw new FileTooLargeError(`超过 ${maxBytes} 字节`);
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function sdkLarkApi(client: Lark.Client): LarkApi {
  let openId: string | undefined;
  const send = async (target: ReplyTarget, msgType: string, content: string): Promise<string> => {
    try {
      if (target.kind === 'chat' || target.kind === 'user') {
        const r = await client.im.v1.message.create({
          params: { receive_id_type: target.kind === 'chat' ? 'chat_id' : 'union_id' },
          data: { receive_id: target.kind === 'chat' ? target.chatId : target.unionId, msg_type: msgType, content, uuid: randomUUID() },
        });
        return String(check('发送消息', r).message_id ?? '');
      }
      const r = await client.im.v1.message.reply({
        path: { message_id: target.messageId },
        data: { msg_type: msgType, content, reply_in_thread: target.inThread, uuid: randomUUID() },
      });
      return String(check('回复消息', r).message_id ?? '');
    } catch (e) {
      rethrow('发送消息', e);
    }
  };
  return {
    sendCard: (t, card) => send(t, 'interactive', JSON.stringify(card)),
    sendText: (t, text) => send(t, 'text', JSON.stringify({ text })),
    async sendFile(t, fileName, content) {
      let fileKey: string;
      try {
        const r = await client.im.v1.file.create({ data: { file_type: 'stream', file_name: fileName, file: content } });
        fileKey = String((r as { file_key?: string })?.file_key ?? check('上传文件', r).file_key ?? '');
      } catch (e) {
        rethrow('上传文件', e);
      }
      if (!fileKey) throw new LarkApiError('上传文件', -1, '没有返回 file_key');
      return send(t, 'file', JSON.stringify({ file_key: fileKey }));
    },
    async patchCard(messageId, card) {
      try {
        check('更新卡片', await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } }));
      } catch (e) {
        rethrow('更新卡片', e);
      }
    },
    async idConvert(messageId) {
      try {
        const d = check('idConvert', await client.cardkit.v1.card.idConvert({ data: { message_id: messageId } }));
        if (!d.card_id) throw new LarkApiError('idConvert', -1, '没有返回 card_id');
        return String(d.card_id);
      } catch (e) {
        rethrow('idConvert', e);
      }
    },
    async cardUpdate(cardId, card, sequence) {
      try {
        check(
          'card.update',
          await client.cardkit.v1.card.update({
            path: { card_id: cardId },
            data: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence, uuid: randomUUID() },
          }),
        );
      } catch (e) {
        rethrow('card.update', e);
      }
    },
    async elementContent(cardId, elementId, content, sequence) {
      try {
        check(
          'cardElement.content',
          await client.cardkit.v1.cardElement.content({
            path: { card_id: cardId, element_id: elementId },
            data: { content, sequence, uuid: randomUUID() },
          }),
        );
      } catch (e) {
        rethrow('cardElement.content', e);
      }
    },
    async cardSettings(cardId, config, sequence) {
      try {
        check(
          'card.settings',
          await client.cardkit.v1.card.settings({
            path: { card_id: cardId },
            data: { settings: JSON.stringify({ config }), sequence, uuid: randomUUID() },
          }),
        );
      } catch (e) {
        rethrow('card.settings', e);
      }
    },
    async patchElement(cardId, elementId, partial, sequence) {
      try {
        check(
          'cardElement.patch',
          await client.cardkit.v1.cardElement.patch({
            path: { card_id: cardId, element_id: elementId },
            data: { partial_element: JSON.stringify(partial), sequence, uuid: randomUUID() },
          }),
        );
      } catch (e) {
        rethrow('cardElement.patch', e);
      }
    },
    async downloadImage(messageId, imageKey) {
      try {
        const r = await client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: imageKey },
          params: { type: 'image' },
        });
        const data = await streamToBuffer(r.getReadableStream(), MAX_IMAGE_BYTES);
        return { data, mimeType: sniffMime(data) };
      } catch (e) {
        rethrow('下载图片', e);
      }
    },
    async downloadFile(messageId, fileKey, maxBytes) {
      try {
        const r = await client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type: 'file' },
        });
        return await streamToBuffer(r.getReadableStream(), maxBytes);
      } catch (e) {
        if (e instanceof FileTooLargeError) throw e;
        rethrow('下载文件', e);
      }
    },
    async botOpenId() {
      if (openId) return openId;
      const r = (await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })) as {
        code?: number;
        msg?: string;
        bot?: { open_id?: string };
      };
      if (r.code !== 0 || !r.bot?.open_id) throw new LarkApiError('bot/v3/info', r.code ?? -1, r.msg ?? '');
      openId = r.bot.open_id;
      return openId;
    },
    async getForwardItems(messageId) {
      // Without card_msg_content_type: using it together with merged forwards returns a 500
      const r = (await client.request({
        method: 'GET',
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        params: { with_sender_name: 'true' },
      })) as { code?: number; msg?: string; data?: { items?: Record<string, unknown>[] } };
      if (r.code !== 0) throw new LarkApiError('读取合并转发', r.code ?? -1, r.msg ?? '');
      return (r.data?.items ?? []).map((it) => {
        const sender = (it.sender ?? {}) as Record<string, unknown>;
        // Several possible locations of the sender name are handled
        const name = [it.sender_name, sender.sender_name, sender.name, (it.sender_i18n_names as Record<string, string> | undefined)?.zh_cn]
          .find((x) => typeof x === 'string' && x) as string | undefined;
        return {
          message_id: String(it.message_id ?? ''),
          chat_id: String(it.chat_id ?? ''),
          chat_type: '',
          message_type: String(it.msg_type ?? ''),
          content: String((it.body as { content?: string } | undefined)?.content ?? ''),
          mentions: (it.mentions as RawMessage['mentions']) ?? [],
          upper_message_id: typeof it.upper_message_id === 'string' ? it.upper_message_id : undefined,
          sender_name: name,
        };
      });
    },
    async userName(unionId) {
      try {
        // Do not use the generated contact.v3.user.get: it sends a {} body with GET, and some gateways answer 411
        const r = (await client.request({
          method: 'GET',
          url: `/open-apis/contact/v3/users/${encodeURIComponent(unionId)}`,
          params: { user_id_type: 'union_id' },
        })) as {
          code?: number;
          data?: { user?: { name?: string } };
        };
        return r.code === 0 && r.data?.user?.name ? r.data.user.name : undefined;
      } catch (e) {
        const code = (e as { response?: { data?: { code?: number } } }).response?.data?.code;
        throw new LarkApiError('查询用户名', code ?? -1, '');
      }
    },
    async getMessage(messageId) {
      try {
        const r = await client.im.v1.message.get({ path: { message_id: messageId } });
        const item = (check('读取消息', r).items as Array<Record<string, unknown>> | undefined)?.[0];
        if (!item) return null;
        return {
          message_id: String(item.message_id ?? messageId),
          chat_id: String(item.chat_id ?? ''),
          chat_type: '',
          message_type: String(item.msg_type ?? ''),
          content: String((item.body as { content?: string } | undefined)?.content ?? ''),
          mentions: (item.mentions as RawMessage['mentions']) ?? [],
        };
      } catch {
        return null;
      }
    },
  };
}

export function newLarkClient(appId: string, appSecret: string): Lark.Client {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
    logger: sdkLogger,
  });
}

/**
 * Logger for the SDK: on errors the SDK may print the whole request/response object (which contains message text and tokens),
 * so only string arguments are kept here, truncated; everything below info is dropped.
 */
const sdkLog = logger('lark-sdk');
const flat = (args: unknown[]): string =>
  args
    .flat(3)
    .filter((a) => typeof a === 'string' || typeof a === 'number')
    .join(' ')
    .slice(0, 300);
export const sdkLogger = {
  error: (...a: unknown[]) => sdkLog.error(flat(a)),
  warn: (...a: unknown[]) => sdkLog.warn(flat(a)),
  info: () => {},
  // The SDK's debug logs include the full event payload (with message text), so they are always dropped
  debug: () => {},
  trace: () => {},
};
