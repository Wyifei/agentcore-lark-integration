// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Conversation anchor and IDs (design 5.4).
 *   anchor           = thread_id ?? chat_id (root_id is not used)
 *   sessionKey       = appId|anchor|userKey
 *   runtimeSessionId = "fs-" + first 40 hex characters of sha256(sessionKey|agentAlias|epoch) (43 characters, >= 33)
 * The alias is part of the calculation: two agents at epoch 0 still get different IDs, so history does not mix when they share one Memory resource.
 */
import { createHash } from 'node:crypto';

export function anchorOf(chatId: string, threadId?: string | null): string {
  return threadId ? threadId : chatId;
}

export function sessionKeyOf(appId: string, anchor: string, userKey: string): string {
  return `${appId}|${anchor}|${userKey}`;
}

export function runtimeSessionIdOf(sessionKey: string, agentAlias: string, epoch: number): string {
  return 'fs-' + createHash('sha256').update(`${sessionKey}|${agentAlias}|${epoch}`, 'utf8').digest('hex').slice(0, 40);
}
