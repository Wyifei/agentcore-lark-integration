// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Administrator identity resolution (design 4.3): email / mobile → union_id, resolved with **the bot's own app**.
 * open_id cannot be used across apps, so union_id is always stored. If resolution fails or is uncertain it raises an error and does not guess.
 */
import type * as Lark from '@larksuiteoapi/node-sdk';
import { isUnionId } from '../config/bots-store.ts';

export class IdentityResolveError extends Error {
  override name = 'IdentityResolveError';
}

export type IdentityInput = { kind: 'union_id'; value: string } | { kind: 'email'; value: string } | { kind: 'mobile'; value: string };

export function classifyIdentity(s: string): IdentityInput {
  const v = s.trim();
  if (isUnionId(v)) return { kind: 'union_id', value: v };
  if (/^ou_/.test(v)) throw new IdentityResolveError('open_id（ou_）不能跨应用使用，请改用 union_id、邮箱或手机号');
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return { kind: 'email', value: v };
  if (/^\+?[0-9][0-9-]{5,19}$/.test(v)) return { kind: 'mobile', value: v.replace(/-/g, '') };
  throw new IdentityResolveError(`无法识别的身份：${v}（支持 union_id、邮箱、手机号）`);
}

export async function resolveUnionId(client: Lark.Client, input: IdentityInput): Promise<string> {
  if (input.kind === 'union_id') return input.value;
  let r: { code?: number; msg?: string; data?: { user_list?: { user_id?: string; email?: string; mobile?: string }[] } };
  try {
    r = (await client.contact.v3.user.batchGetId({
      params: { user_id_type: 'union_id' },
      data: input.kind === 'email' ? { emails: [input.value] } : { mobiles: [input.value] },
    })) as typeof r;
  } catch (e) {
    const d = (e as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
    throw new IdentityResolveError(`解析${input.kind === 'email' ? '邮箱' : '手机号'}失败：${d ? `code=${d.code} ${d.msg}` : (e as Error).message}`);
  }
  if (r.code !== 0) throw new IdentityResolveError(`解析失败：code=${r.code} ${r.msg ?? ''}（应用需要 contact:user.id:readonly 权限）`);
  const id = r.data?.user_list?.[0]?.user_id;
  if (!id) throw new IdentityResolveError('没有找到这个用户（不在本企业，或不在应用的可见范围内）');
  if (!isUnionId(id)) throw new IdentityResolveError(`返回的 ID 不是 union_id：${id}`);
  return id;
}
