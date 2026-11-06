// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * HMAC password-derivation secret (design 5.3, 10): read AWSCURRENT and AWSPREVIOUS (the latter may not exist) from Secrets Manager.
 * Read again on SIGHUP (call reload).
 */
import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface HmacKeys {
  current: Buffer;
  previous: Buffer | null;
}

export interface SecretFetcher {
  /** Return the SecretString of the given version label; null when the version does not exist */
  fetch(stage: 'AWSCURRENT' | 'AWSPREVIOUS'): Promise<string | null>;
}

export function secretsManagerFetcher(client: SecretsManagerClient, secretId: string): SecretFetcher {
  return {
    async fetch(stage) {
      try {
        const r = await client.send(new GetSecretValueCommand({ SecretId: secretId, VersionStage: stage }));
        return r.SecretString ?? (r.SecretBinary ? Buffer.from(r.SecretBinary).toString('utf8') : null);
      } catch (e) {
        if (e instanceof ResourceNotFoundException && stage === 'AWSPREVIOUS') return null;
        throw e;
      }
    },
  };
}

/** SecretString can be a plain string or `{"key": "..."}`. */
export function parseSecretString(s: string): Buffer {
  const t = s.trim();
  if (t.startsWith('{')) {
    const o = JSON.parse(t) as { key?: unknown };
    if (typeof o.key !== 'string' || !o.key) throw new Error('HMAC secret JSON 缺少 key 字段');
    return Buffer.from(o.key, 'utf8');
  }
  if (t.length < 32) throw new Error('HMAC secret 太短（至少 32 字符）');
  return Buffer.from(t, 'utf8');
}

export class HmacKeyStore {
  private keys: HmacKeys | null = null;
  private readonly fetcher: SecretFetcher;
  constructor(fetcher: SecretFetcher) {
    this.fetcher = fetcher;
  }

  async reload(): Promise<void> {
    const [cur, prev] = await Promise.all([this.fetcher.fetch('AWSCURRENT'), this.fetcher.fetch('AWSPREVIOUS')]);
    if (!cur) throw new Error('HMAC secret 没有 AWSCURRENT 版本');
    this.keys = { current: parseSecretString(cur), previous: prev ? parseSecretString(prev) : null };
  }

  get(): HmacKeys {
    if (!this.keys) throw new Error('HMAC 密钥尚未加载');
    return this.keys;
  }
}
