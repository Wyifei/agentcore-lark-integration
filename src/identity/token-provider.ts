// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Issue access tokens for Feishu users (design 5.3).
 *
 * - Cached in memory by (userKey, clientId); 2 minutes before expiry a refresh token is exchanged for a new one; when the refresh token is invalid, password authentication is used again.
 * - Password authentication first uses the password derived from AWSCURRENT; on failure it immediately tries AWSPREVIOUS once and does not retry AWSCURRENT.
 *   **No retry loop**: Cognito locks the user after 5 consecutive failures.
 * - Concurrent requests for the same (userKey, clientId) are merged into one.
 * - Tokens are never written to disk or logged.
 */
import {
  RefreshRejectedError,
  UserNotFoundError,
  UsernameExistsError,
  WrongPasswordError,
  type AuthTokens,
  type CognitoApi,
} from './cognito.ts';
import type { HmacKeyStore } from './hmac-secret.ts';
import { derivePassword } from './password.ts';
import { logger } from '../util/log.ts';

const log = logger('identity');

export const REFRESH_BEFORE_MS = 2 * 60_000;

interface CacheEntry {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export class TokenProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();
  /** Users confirmed to exist with their password set in this process */
  private readonly ensured = new Set<string>();

  private readonly cognito: CognitoApi;
  private readonly keys: HmacKeyStore;
  private readonly now: () => number;

  constructor(cognito: CognitoApi, keys: HmacKeyStore, now: () => number = Date.now) {
    this.cognito = cognito;
    this.keys = keys;
    this.now = now;
  }

  async getAccessToken(userKey: string, clientId: string): Promise<string> {
    const k = `${clientId}\n${userKey}`;
    const hit = this.cache.get(k);
    if (hit && hit.expiresAt - REFRESH_BEFORE_MS > this.now()) return hit.accessToken;
    const running = this.inflight.get(k);
    if (running) return running;
    const p = this.obtain(k, userKey, clientId, hit).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  /** Invalidate the cache of a user (for example when the runtime returns 401). */
  invalidate(userKey: string, clientId: string): void {
    this.cache.delete(`${clientId}\n${userKey}`);
  }

  /** After unbinding, clear all cache entries of that client. */
  dropClient(clientId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${clientId}\n`)) this.cache.delete(k);
  }

  private store(k: string, t: AuthTokens, prevRefresh?: string): string {
    this.cache.set(k, {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken ?? prevRefresh,
      expiresAt: this.now() + t.expiresInSec * 1000,
    });
    return t.accessToken;
  }

  private async obtain(k: string, userKey: string, clientId: string, prev: CacheEntry | undefined): Promise<string> {
    if (prev?.refreshToken) {
      try {
        return this.store(k, await this.cognito.refreshAuth(clientId, prev.refreshToken), prev.refreshToken);
      } catch (e) {
        if (!(e instanceof RefreshRejectedError)) throw e;
        this.cache.delete(k);
        log.info('refresh token 失效，改用密码认证');
      }
    }
    await this.ensureUser(userKey);
    return this.store(k, await this.passwordAuth(userKey, clientId));
  }

  /** CURRENT fails → PREVIOUS once; no loop. */
  private async passwordAuth(userKey: string, clientId: string): Promise<AuthTokens> {
    const { current, previous } = this.keys.get();
    try {
      return await this.cognito.passwordAuth(clientId, userKey, derivePassword(current, userKey));
    } catch (e) {
      if (e instanceof UserNotFoundError) this.ensured.delete(userKey);
      if (!(e instanceof WrongPasswordError) || !previous) throw e;
    }
    log.info('AWSCURRENT 认证失败，改用 AWSPREVIOUS 一次');
    return this.cognito.passwordAuth(clientId, userKey, derivePassword(previous, userKey));
  }

  /**
   * Create the user when it does not exist: AdminCreateUser(SUPPRESS) → AdminSetUserPassword(Permanent).
   * Create only, never delete (the sub is the root of identity, design 5.3).
   */
  private async ensureUser(userKey: string): Promise<void> {
    if (this.ensured.has(userKey)) return;
    const u = await this.cognito.getUser(userKey);
    if (!u) {
      try {
        await this.cognito.createUser(userKey);
        log.info('已创建 Cognito 用户');
      } catch (e) {
        if (!(e instanceof UsernameExistsError)) throw e;
        // Concurrent creation: another call already created it and may not have set the password yet, so set it once more (harmless)
      }
      await this.cognito.setPermanentPassword(userKey, derivePassword(this.keys.get().current, userKey));
    } else if (u.status === 'FORCE_CHANGE_PASSWORD') {
      await this.cognito.setPermanentPassword(userKey, derivePassword(this.keys.get().current, userKey));
    }
    this.ensured.add(userKey);
  }
}
