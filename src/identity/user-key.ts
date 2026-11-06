// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * userKey = "feishu:" + tenant_key + ":" + union_id (design 5.3).
 * open_id is not used: it is only valid in the app that issued it.
 */
export interface FeishuSender {
  sender_id?: { union_id?: string; open_id?: string; user_id?: string };
  tenant_key?: string;
}

export class MissingIdentityError extends Error {
  override name = 'MissingIdentityError';
}

export function userKeyOf(tenantKey: string | undefined, unionId: string | undefined): string {
  if (!tenantKey || !unionId) throw new MissingIdentityError(`发送人缺少 ${!tenantKey ? 'tenant_key' : 'union_id'}`);
  if (!unionId.startsWith('on_')) throw new MissingIdentityError('union_id 格式不对');
  if (!/^[A-Za-z0-9_-]+$/.test(tenantKey)) throw new MissingIdentityError('tenant_key 格式不对');
  return `feishu:${tenantKey}:${unionId}`;
}
