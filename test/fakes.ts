// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import type { LarkApi, ReplyTarget } from '../src/lark/api.ts';
import type { RawMessage } from '../src/lark/message-parser.ts';

export interface Call {
  op: string;
  args: unknown[];
}

export class FakeLark implements LarkApi {
  calls: Call[] = [];
  n = 0;
  failElement = 0;
  messages = new Map<string, RawMessage>();
  /** Delay of each card write (simulates the time of a CardKit write) */
  writeDelayMs = 0;
  private rec(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }
  private async delay() {
    if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
  }
  ops(op: string) {
    return this.calls.filter((c) => c.op === op);
  }
  async sendCard(t: ReplyTarget, card: object) {
    this.rec('sendCard', t, card);
    return `om_${++this.n}`;
  }
  async sendText(t: ReplyTarget, text: string) {
    this.rec('sendText', t, text);
    return `om_${++this.n}`;
  }
  async sendFile(t: ReplyTarget, name: string, content: Buffer) {
    this.rec('sendFile', t, name, content.length);
    return `om_${++this.n}`;
  }
  async patchCard(id: string, card: object) {
    this.rec('patchCard', id, card);
  }
  async idConvert(id: string) {
    this.rec('idConvert', id);
    return `card_${id}`;
  }
  async cardUpdate(id: string, card: object, seq: number) {
    await this.delay();
    this.rec('cardUpdate', id, card, seq);
  }
  async elementContent(id: string, el: string, content: string, seq: number) {
    await this.delay();
    if (this.failElement > 0) {
      this.failElement--;
      throw Object.assign(new Error('x'), { code: 1 });
    }
    this.rec('elementContent', id, el, content, seq);
  }
  async patchElement(id: string, el: string, partial: object, seq: number) {
    this.rec('patchElement', id, el, partial, seq);
  }
  async cardSettings(id: string, config: object, seq: number) {
    this.rec('cardSettings', id, config, seq);
  }
  async downloadImage(messageId: string, key: string) {
    this.rec('downloadImage', messageId, key);
    return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' };
  }
  fileSizes = new Map<string, number>();
  async downloadFile(messageId: string, key: string, maxBytes: number) {
    this.rec('downloadFile', messageId, key);
    const n = this.fileSizes.get(key) ?? 10;
    if (n > maxBytes) {
      const { FileTooLargeError } = await import('../src/lark/api.ts');
      throw new FileTooLargeError('too large');
    }
    return Buffer.alloc(n, 0x61);
  }
  async botOpenId() {
    return 'ou_bot';
  }
  forwards = new Map<string, import('../src/lark/message-parser.ts').ForwardItem[]>();
  async getForwardItems(id: string) {
    return this.forwards.get(id) ?? [];
  }
  names = new Map<string, string>();
  async userName(unionId: string) {
    this.rec('userName', unionId);
    return this.names.get(unionId);
  }
  async getMessage(id: string) {
    return this.messages.get(id) ?? null;
  }
}

/** A fetch that returns an SSE response; gate controls when it ends */
export function sseFetch(events: unknown[], opts: { status?: number; hold?: Promise<void>; onRequest?: (url: string, init: RequestInit) => void } = {}) {
  return (async (url: string, init: RequestInit) => {
    opts.onRequest?.(url, init);
    if (opts.status && opts.status !== 200) return new Response('{"message":"denied"}', { status: opts.status });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        for (const e of events) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        if (opts.hold) {
          await Promise.race([
            opts.hold,
            new Promise<void>((_r, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
          ]).catch((e) => {
            ctrl.error(e);
            throw e;
          });
        }
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}
