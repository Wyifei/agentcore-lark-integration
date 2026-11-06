// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { mkdtempSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  addAdmin,
  emptyBotsFile,
  readBotsFile,
  updateBotsFile,
  upsertAgent,
  validateBotsFile,
  writeBotsFileAtomic,
  type BotConfig,
} from '../src/config/bots-store.ts';

const ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-AbC123';

function bot(over: Partial<BotConfig> = {}): BotConfig {
  return {
    appId: 'cli_a1',
    appSecret: 's3cret',
    appName: 'bot',
    agents: [{ alias: 'default', runtimeArn: ARN, qualifier: 'DEFAULT', clientId: 'c1', status: 'pending', verifiedAt: null }],
    defaultAgent: 'default',
    admins: ['on_abc'],
    allowedUsers: [],
    allowAll: false,
    turnTimeoutSec: 600,
    createdAt: '2026-11-05T00:00:00Z',
    ...over,
  };
}
function file(bots: BotConfig[] = [bot()]) {
  return { ...emptyBotsFile({ userPoolId: 'us-west-2_x', hmacSecretArn: 'arn:secret' }), bots };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'afb-'));

describe('bots-store', () => {
  it('原子写，权限 0600，不留临时文件', () => {
    const d = tmp();
    const p = join(d, 'bots.json');
    writeBotsFileAtomic(p, file());
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(['bots.json']);
    expect(readBotsFile(p).bots[0]!.appId).toBe('cli_a1');
  });

  it('写入非法内容时抛错且不覆盖旧文件', () => {
    const p = join(tmp(), 'bots.json');
    writeBotsFileAtomic(p, file());
    const before = readFileSync(p, 'utf8');
    expect(() => writeBotsFileAtomic(p, file([bot({ turnTimeoutSec: 4000 })]))).toThrow(ConfigError);
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it.each([
    ['schemaVersion', { ...file(), schemaVersion: 2 }],
    ['turnTimeoutSec 超过 3600', file([bot({ turnTimeoutSec: 3601 })])],
    ['defaultAgent 不存在', file([bot({ defaultAgent: 'nope' })])],
    ['admins 用了 open_id', file([bot({ admins: ['ou_xxx'] })])],
    ['appId 重复', file([bot(), bot()])],
    ['runtimeArn 不合法', file([bot({ agents: [{ ...bot().agents[0]!, runtimeArn: 'arn:x' }] })])],
    ['status 非法', file([bot({ agents: [{ ...bot().agents[0]!, status: 'ok' as never }] })])],
    ['缺 userPoolId', { ...file(), settings: { hmacSecretArn: 'x' } }],
  ])('拒绝：%s', (_n, raw) => {
    expect(() => validateBotsFile(raw)).toThrow(ConfigError);
  });

  it('3600 可以加载，默认值补齐', () => {
    const f = validateBotsFile(file([{ ...bot({ turnTimeoutSec: 3600 }), storePromptText: undefined }]));
    expect(f.bots[0]!.turnTimeoutSec).toBe(3600);
    expect(f.bots[0]!.storePromptText).toBe(true);
  });

  it('旧字段 keepLastPrompt 兼容，写回时改成 storePromptText', () => {
    const f = validateBotsFile(file([{ ...bot(), keepLastPrompt: false } as BotConfig]));
    expect(f.bots[0]!.storePromptText).toBe(false);
    expect('keepLastPrompt' in f.bots[0]!).toBe(false);
  });

  it('JSON 损坏时拒绝加载', () => {
    const p = join(tmp(), 'bots.json');
    writeFileSync(p, '{oops');
    expect(() => readBotsFile(p)).toThrow(ConfigError);
  });

  it('updateBotsFile 加锁读改写，并发不丢更新', async () => {
    const p = join(tmp(), 'bots.json');
    writeBotsFileAtomic(p, file());
    await Promise.all(
      ['on_1', 'on_2', 'on_3', 'on_4'].map((u) => updateBotsFile(p, (f) => void addAdmin(f.bots[0]!, u))),
    );
    expect(readBotsFile(p).bots[0]!.admins.sort()).toEqual(['on_1', 'on_2', 'on_3', 'on_4', 'on_abc']);
  });

  it('upsertAgent 在没有默认时设为默认', () => {
    const b = bot({ agents: [], defaultAgent: '' });
    upsertAgent(b, { ...bot().agents[0]!, alias: 'x' });
    expect(b.defaultAgent).toBe('x');
  });
});
