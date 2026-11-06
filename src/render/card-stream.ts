// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * CardKit streaming writer (design 7.2).
 *
 * 1. Send a streaming-layout Card 2.0 card (streaming_mode is turned on directly in config), or replace a queued card in place with the streaming layout;
 * 2. get the card entity ID with idConvert;
 * 3. the stream-reading loop only changes in-memory state and calls `changed()`; cards are written in a separate write loop: each write sends only the latest full text,
 *    intermediate versions are dropped, and the next write is sent only after the previous one finishes. Tools, status, and body are written in the same tick;
 * 4. at the end one card.update swaps in the final layout (turn off streaming_mode, summary, title, footer, buttons).
 *
 * All writes to one card are serialized in this object, and sequence increases monotonically.
 */
import type { LarkApi, ReplyTarget } from '../lark/api.ts';
import { buildFinalCardFitted, buildStreamingCard, ELEMENT, statusMarkdown, streamingAnswer, toolsMarkdown } from './cards.ts';
import type { TurnState } from './turn-state.ts';
import { logger } from '../util/log.ts';

const log = logger('render');

export interface CardStreamOptions {
  /** Minimum interval between two writes (conservative, to stay within CardKit rate limits) */
  minIntervalMs?: number;
}

export class CardStream {
  private readonly api: LarkApi;
  private readonly target: ReplyTarget;
  private readonly st: TurnState;
  private readonly minIntervalMs: number;
  private cardId: string | null = null;
  messageId: string | null = null;
  private seq = 0;
  private dirty = false;
  private loop: Promise<void> | null = null;
  private written: Record<string, string> = {};
  private broken = false;
  private finished = false;
  private failures = 0;

  constructor(api: LarkApi, target: ReplyTarget, state: TurnState, opts: CardStreamOptions = {}) {
    this.api = api;
    this.target = target;
    this.st = state;
    this.minIntervalMs = opts.minIntervalMs ?? 150;
  }

  /** Open the streaming card. existingMessageId is a queued card sent earlier, which is replaced in place. */
  async open(existingMessageId?: string): Promise<void> {
    const card = buildStreamingCard(this.st);
    if (existingMessageId) {
      try {
        this.messageId = existingMessageId;
        this.cardId = await this.api.idConvert(existingMessageId);
        await this.api.cardUpdate(this.cardId, card, ++this.seq);
        this.rememberWritten();
        return;
      } catch (e) {
        log.warn('排队卡片无法转为流式卡片，改发新卡片', { err: e });
        this.cardId = null;
      }
    }
    this.messageId = await this.api.sendCard(this.target, card);
    this.rememberWritten();
    try {
      this.cardId = await this.api.idConvert(this.messageId);
    } catch (e) {
      // Without a card entity there are no streaming updates, and the final card is written with im.message.patch at the end
      log.warn('idConvert 失败，本轮不做流式更新', { err: e });
      this.broken = true;
    }
  }

  private rememberWritten(): void {
    this.written = {
      [ELEMENT.status]: statusMarkdown(this.st) || ' ',
      [ELEMENT.tools]: toolsMarkdown(this.st.tools) || ' ',
      [ELEMENT.answer]: streamingAnswer(this.st) || ' ',
    };
  }

  /** State changed: schedule a write (merged) */
  changed(): void {
    if (this.finished || this.broken || !this.cardId) return;
    this.dirty = true;
    if (!this.loop) this.loop = this.writeLoop().finally(() => (this.loop = null));
  }

  private async writeLoop(): Promise<void> {
    while (this.dirty && !this.finished && !this.broken) {
      this.dirty = false;
      const started = Date.now();
      const next: Record<string, string> = {
        [ELEMENT.status]: statusMarkdown(this.st) || ' ',
        [ELEMENT.tools]: toolsMarkdown(this.st.tools) || ' ',
        [ELEMENT.answer]: streamingAnswer(this.st) || ' ',
      };
      for (const [id, content] of Object.entries(next)) {
        if (this.written[id] === content || this.finished) continue;
        try {
          await this.api.elementContent(this.cardId!, id, content, ++this.seq);
          this.written[id] = content;
        } catch (e) {
          this.failures++;
          log.warn('流式写卡片失败', { err: e, element: id, failures: this.failures });
          // Consecutive failures (card recalled, streaming already closed, persistent rate limiting): stop streaming writes and replace the whole card at the end
          if (this.failures >= 3) this.broken = true;
          continue;
        }
        this.failures = 0;
      }
      const wait = this.minIntervalMs - (Date.now() - started);
      if (wait > 0 && this.dirty) await new Promise((r) => setTimeout(r, wait));
    }
  }

  /**
   * Finish: wait for the write loop to stop and swap in the final layout. Returns whether it was truncated (when truncated a .md file was sent separately).
   */
  async finish(fileName = 'reply.md'): Promise<{ truncated: boolean }> {
    this.finished = true;
    if (this.loop) await this.loop.catch(() => {});
    const { card, truncated } = buildFinalCardFitted(this.st);
    this.st.truncated = truncated;
    let ok = false;
    if (this.cardId) {
      try {
        await this.api.cardUpdate(this.cardId, card, ++this.seq);
        ok = true;
      } catch (e) {
        log.warn('最终卡片 card.update 失败', { err: e });
      }
    }
    if (!ok && this.messageId) {
      try {
        await this.api.patchCard(this.messageId, card);
        ok = true;
      } catch (e) {
        log.warn('最终卡片 patch 失败', { err: e });
      }
    }
    if (!ok) {
      try {
        this.messageId = await this.api.sendCard(this.target, card);
      } catch (e) {
        log.error('最终卡片发送失败', { err: e });
      }
    }
    if (truncated) {
      try {
        await this.api.sendFile(this.target, fileName, Buffer.from(this.st.answer, 'utf8'));
      } catch (e) {
        log.error('完整回复文件发送失败', { err: e });
      }
    }
    return { truncated };
  }
}
