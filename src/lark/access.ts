// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/** Authorization decision (design 5.2): administrator / chat user / no permission. Identity is always the union_id. */
import type { BotConfig } from '../config/bots-store.ts';

export type Role = 'admin' | 'user' | 'none';

export function roleOf(bot: Pick<BotConfig, 'admins' | 'allowedUsers' | 'allowAll'>, unionId: string): Role {
  if (bot.admins.includes(unionId)) return 'admin';
  if (bot.allowAll || bot.allowedUsers.includes(unionId)) return 'user';
  return 'none';
}

export const NO_PERMISSION_TEXT = '你还没有使用这个机器人的权限，请联系管理员添加。';
