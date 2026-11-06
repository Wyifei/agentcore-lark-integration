// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Password derivation (design 5.3): base64url(HMAC-SHA256(secret, userKey)) + the fixed suffix "Aa1!".
 * The suffix guarantees an uppercase letter, a lowercase letter, a digit, and a symbol, so it complies with any user pool password policy (length 47).
 */
import { createHmac } from 'node:crypto';

export const PASSWORD_SUFFIX = 'Aa1!';

export function derivePassword(key: Buffer, userKey: string): string {
  return createHmac('sha256', key).update(userKey, 'utf8').digest('base64url') + PASSWORD_SUFFIX;
}
