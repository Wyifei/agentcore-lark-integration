// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Runtime check for bind (design 4.6, 5.3): read the authorizer configuration with GetAgentRuntime and check
 *   1. customJWTAuthorizer points at this project's user pool and allowedClients contains this binding's client;
 *   2. requestHeaderAllowlist contains Authorization.
 * The authorizer configuration can be fixed per version, so GetAgentRuntimeEndpoint is used first to find the version the qualifier currently points at.
 * It never modifies the customer's runtime.
 */
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
  ListAgentRuntimesCommand,
  type GetAgentRuntimeResponse,
} from '@aws-sdk/client-bedrock-agentcore-control';

export function runtimeIdOf(arn: string): string {
  const id = arn.split('/').pop();
  if (!id) throw new Error(`runtime ARN 格式不对: ${arn}`);
  return id;
}

export function discoveryUrlFor(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
}

export interface RuntimeSummary {
  arn: string;
  name: string;
  status: string;
}

export async function listRuntimes(client: BedrockAgentCoreControlClient): Promise<RuntimeSummary[]> {
  const out: RuntimeSummary[] = [];
  let nextToken: string | undefined;
  do {
    const r = await client.send(new ListAgentRuntimesCommand({ nextToken, maxResults: 100 }));
    for (const a of r.agentRuntimes ?? []) {
      out.push({ arn: a.agentRuntimeArn ?? '', name: a.agentRuntimeName ?? '', status: String(a.status ?? '') });
    }
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

export type CheckItem = 'discoveryUrl' | 'allowedClients' | 'authorizationHeader';

export interface RuntimeCheck {
  ok: boolean;
  missing: CheckItem[];
  version?: string;
  /** The currently configured authorization method, used for hints ("IAM" means JWT is not configured) */
  authMode: 'JWT' | 'IAM';
}

export function evaluateRuntime(
  rt: Pick<GetAgentRuntimeResponse, 'authorizerConfiguration' | 'requestHeaderConfiguration'>,
  expectedDiscoveryUrl: string,
  clientId: string,
): Omit<RuntimeCheck, 'version'> {
  const missing: CheckItem[] = [];
  const jwt = rt.authorizerConfiguration && 'customJWTAuthorizer' in rt.authorizerConfiguration
    ? rt.authorizerConfiguration.customJWTAuthorizer
    : undefined;
  if (!jwt || jwt.discoveryUrl?.replace(/\/$/, '') !== expectedDiscoveryUrl) missing.push('discoveryUrl');
  if (!jwt?.allowedClients?.includes(clientId)) missing.push('allowedClients');
  const allow = rt.requestHeaderConfiguration && 'requestHeaderAllowlist' in rt.requestHeaderConfiguration
    ? (rt.requestHeaderConfiguration.requestHeaderAllowlist ?? [])
    : [];
  if (!allow.some((h) => h.toLowerCase() === 'authorization')) missing.push('authorizationHeader');
  return { ok: missing.length === 0, missing, authMode: jwt ? 'JWT' : 'IAM' };
}

export async function checkRuntime(
  client: BedrockAgentCoreControlClient,
  runtimeArn: string,
  qualifier: string,
  expectedDiscoveryUrl: string,
  clientId: string,
): Promise<RuntimeCheck> {
  const agentRuntimeId = runtimeIdOf(runtimeArn);
  let version: string | undefined;
  try {
    const ep = await client.send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId, endpointName: qualifier }));
    version = ep.liveVersion ?? undefined;
  } catch (e) {
    if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
    throw new Error(`runtime 上没有名为 ${qualifier} 的 endpoint`, { cause: e });
  }
  const rt = await client.send(
    new GetAgentRuntimeCommand({ agentRuntimeId, ...(version ? { agentRuntimeVersion: version } : {}) }),
  );
  return { ...evaluateRuntime(rt, expectedDiscoveryUrl, clientId), version };
}

export const CHECK_TEXT: Record<CheckItem, string> = {
  discoveryUrl: 'authorizerConfiguration.customJWTAuthorizer.discoveryUrl 没有指向本项目的用户池',
  allowedClients: 'customJWTAuthorizer.allowedClients 不包含这次绑定的 client',
  authorizationHeader: 'requestHeaderConfiguration.requestHeaderAllowlist 不包含 Authorization',
};

/** Configuration snippet the customer's runtime needs (design 5.3) */
export function requiredConfigSnippet(discoveryUrl: string, clientIds: string[]): string {
  return JSON.stringify(
    {
      authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl, allowedClients: clientIds } },
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
    },
    null,
    2,
  );
}

export const MIGRATION_NOTE = [
  '注意：runtime 的 JWT 认证和 IAM 认证互斥。改成 JWT 后，这个 runtime 的新版本不再接受 SigV4（IAM）调用。',
  '如果还有其他程序用 IAM 调用它，二选一：',
  '  1. （推荐）用同一镜像另建一个 JWT 认证的 runtime 给本机器人使用，原 runtime 不动；',
  '  2. 先建一个 endpoint 钉在当前版本，让 IAM 调用方改用它，再改成 JWT（钉住的 endpoint 代码也冻结在该版本，只适合过渡）。',
  '本工具不会替你修改 runtime。',
].join('\n');
