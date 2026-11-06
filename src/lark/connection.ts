// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * One WSClient long connection per bot (design 5.1):
 * - pingTimeout cuts half-open connections, and handshakeTimeoutMs keeps the handshake from hanging;
 * - after the SDK exhausts its reconnect attempts it stays in failed; probe once a minute and call start() again.
 *
 * Portions adapted from botmux (MIT License), see THIRD-PARTY-LICENSES.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { sdkLogger } from './api.ts';
import type { ConnState } from '../store/status-file.ts';
import { logger } from '../util/log.ts';

const log = logger('lark-ws');

export interface ConnectionHandlers {
  onMessage(data: unknown): Promise<void> | void;
  /** The return value is the reply to the card callback (toast and so on) and must be returned within 3 seconds */
  onCardAction(data: unknown): Promise<unknown> | unknown;
  onStateChange(state: ConnState): void;
}

export class BotConnection {
  private readonly ws: Lark.WSClient;
  private readonly dispatcher: Lark.EventDispatcher;
  private readonly reviveTimer: NodeJS.Timeout;
  private readonly appId: string;
  state: ConnState = 'connecting';
  since = new Date().toISOString();

  constructor(appId: string, appSecret: string, h: ConnectionHandlers) {
    this.appId = appId;
    const setState = (s: ConnState) => {
      if (s === this.state) return;
      this.state = s;
      this.since = new Date().toISOString();
      h.onStateChange(s);
    };
    this.dispatcher = new Lark.EventDispatcher({ logger: sdkLogger, loggerLevel: Lark.LoggerLevel.warn }).register({
      // Do not await the business handling: events on a long connection must be ACKed quickly, and the work runs in the background
      'im.message.receive_v1': (data: unknown) => {
        void Promise.resolve()
          .then(() => h.onMessage(data))
          .catch((e) => log.error('处理消息失败', { appId, err: e }));
      },
      'im.chat.member.bot.added_v1': () => log.info('机器人被拉进群', { appId }),
      'im.chat.member.bot.deleted_v1': () => log.info('机器人被移出群', { appId }),
      'card.action.trigger': (data: unknown) => h.onCardAction(data),
    } as never);

    this.ws = new Lark.WSClient({
      appId,
      appSecret,
      domain: Lark.Domain.Feishu,
      logger: sdkLogger,
      loggerLevel: Lark.LoggerLevel.warn,
      wsConfig: { pingTimeout: 30 },
      handshakeTimeoutMs: 15_000,
      onReady: () => {
        log.info('长连接已建立', { appId });
        setState('connected');
      },
      onReconnecting: () => {
        log.warn('长连接重连中', { appId });
        setState('reconnecting');
      },
      onReconnected: () => {
        log.info('长连接已恢复', { appId });
        setState('connected');
      },
      onError: (err) => {
        log.error('长连接失败', { appId, err });
        setState('error');
      },
    });
    void Promise.resolve(this.ws.start({ eventDispatcher: this.dispatcher })).catch((e) => {
      log.error('长连接首次连接失败', { appId, err: e });
      setState('error');
    });

    let reviving = false;
    this.reviveTimer = setInterval(() => {
      if (reviving || this.ws.getConnectionStatus().state !== 'failed') return;
      reviving = true;
      log.warn('重连已放弃，重新启动长连接', { appId });
      setState('reconnecting');
      this.ws
        .start({ eventDispatcher: this.dispatcher })
        .catch((e) => log.error('重新启动长连接失败', { appId, err: e }))
        .finally(() => (reviving = false));
    }, 60_000);
    this.reviveTimer.unref();
  }

  close(): void {
    clearInterval(this.reviveTimer);
    try {
      this.ws.close({ force: true });
    } catch (e) {
      log.warn('关闭长连接出错', { appId: this.appId, err: e });
    }
    this.state = 'disconnected';
  }
}
