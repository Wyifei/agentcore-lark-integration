// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Reply location (design 5.4):
 * - with thread_id: the reply API + reply_in_thread, landing in the same topic;
 * - direct message: send directly;
 * - normal group: quote the user's message without creating a new topic.
 */
import type { ReplyTarget } from './api.ts';

export function replyTargetFor(m: { messageId: string; chatId: string; chatType: string; threadId?: string | null }): ReplyTarget {
  if (m.threadId) return { kind: 'reply', messageId: m.messageId, inThread: true };
  if (m.chatType === 'p2p') return { kind: 'chat', chatId: m.chatId };
  return { kind: 'reply', messageId: m.messageId, inThread: false };
}
