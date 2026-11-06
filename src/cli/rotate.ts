// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * rotate-secret (design 5.3): the host-side steps of HMAC secret rotation.
 *
 * 1. The administrator first writes a new version on their own computer with put-secret-value (the new version becomes AWSCURRENT and the old one AWSPREVIOUS);
 * 2. On the host, `rotate-secret --apply`: list all users of the user pool and call AdminSetUserPassword one by one with the password derived from AWSCURRENT,
 *    then reload so the service switches to the new secret.
 *
 * It uses only the GetSecretValue / ListUsers / AdminSetUserPassword permissions the instance role already has. It can be re-run after a midway failure, and setting the password again for users already handled is harmless.
 * It takes rotate.lock and refuses a concurrent second rotation. During rotation the service authenticates with AWSCURRENT first and AWSPREVIOUS once if that fails, so there is no interruption.
 */
import { AdminSetUserPasswordCommand, ListUsersCommand, type CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { paths } from '../config/paths.ts';
import { HmacKeyStore, secretsManagerFetcher, type SecretFetcher } from '../identity/hmac-secret.ts';
import { derivePassword } from '../identity/password.ts';
import { LockBusyError, withFileLock } from '../util/file-lock.ts';
import { CliError, out, type CliEnv } from './context.ts';

export async function listAllUsernames(cognito: Pick<CognitoIdentityProviderClient, 'send'>, userPoolId: string): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const r = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60, PaginationToken: token }));
    for (const u of r.Users ?? []) if (u.Username) names.push(u.Username);
    token = r.PaginationToken;
  } while (token);
  return names;
}

export interface RotateResult {
  total: number;
  ok: number;
  failed: number;
}

/** Returns whether a reload is needed */
export async function rotateSecret(
  env: CliEnv,
  apply: boolean,
  fetcher: SecretFetcher = secretsManagerFetcher(new SecretsManagerClient({ region: env.region }), env.file.settings.hmacSecretArn),
): Promise<RotateResult | null> {
  const keys = new HmacKeyStore(fetcher);
  await keys.reload();
  const { current, previous } = keys.get();
  const users = await listAllUsernames(env.cognito, env.file.settings.userPoolId);
  if (!apply) {
    out(`用户池 ${env.file.settings.userPoolId} 里有 ${users.length} 个用户。`);
    out(previous ? '已存在 AWSPREVIOUS 版本（新密钥可能已经写入）。' : '没有 AWSPREVIOUS 版本：还没有写入过新密钥。');
    out('');
    out('轮换步骤：');
    out(`  1. 在自己电脑上用管理员凭证写入新密钥：`);
    out(`     aws secretsmanager put-secret-value --secret-id ${env.file.settings.hmacSecretArn} --secret-string "$(openssl rand -base64 48 | tr -d '/+=')"`);
    out('  2. 在主机上运行：agentcore-chat-bridge rotate-secret --apply');
    return null;
  }
  if (!previous) throw new CliError('没有 AWSPREVIOUS 版本：请先在自己电脑上用 put-secret-value 写入新密钥（运行 rotate-secret 查看步骤）。');
  if (previous.equals(current)) throw new CliError('AWSCURRENT 和 AWSPREVIOUS 相同，新密钥没有生效。');
  try {
    return await withFileLock(
      paths.rotateLock(),
      async () => {
        out(`为 ${users.length} 个用户重设密码（使用 AWSCURRENT）…`);
        let ok = 0;
        let failed = 0;
        for (const username of users) {
          try {
            await env.cognito.send(
              new AdminSetUserPasswordCommand({
                UserPoolId: env.file.settings.userPoolId,
                Username: username,
                Password: derivePassword(current, username),
                Permanent: true,
              }),
            );
            ok++;
          } catch (e) {
            failed++;
            out(`  ✗ ${username}: ${(e as Error).name}`);
          }
        }
        out(`完成：成功 ${ok}，失败 ${failed}。${failed ? '可以直接重跑 rotate-secret --apply。' : ''}`);
        return { total: users.length, ok, failed };
      },
      { waitMs: 0 },
    );
  } catch (e) {
    if (e instanceof LockBusyError) throw new CliError('另一个 rotate-secret --apply 正在运行。');
    throw e;
  }
}
