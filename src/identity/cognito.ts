// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Access to the Cognito user pool (design 5.3): used only to mint tokens, not for end-user sign-in.
 * A narrow interface is defined here; the real implementation wraps the SDK and tests use a fake.
 */
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  DeleteUserPoolClientCommand,
  DescribeUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';

export interface AuthTokens {
  accessToken: string;
  /** REFRESH_TOKEN_AUTH does not always return a new refresh token */
  refreshToken?: string;
  expiresInSec: number;
}

export type UserStatus = 'CONFIRMED' | 'FORCE_CHANGE_PASSWORD' | string;

export interface CognitoApi {
  /** Returns null when the user does not exist */
  getUser(username: string): Promise<{ status: UserStatus; enabled: boolean } | null>;
  /** Throws UsernameExistsError when the user already exists */
  createUser(username: string): Promise<void>;
  setPermanentPassword(username: string, password: string): Promise<void>;
  passwordAuth(clientId: string, username: string, password: string): Promise<AuthTokens>;
  refreshAuth(clientId: string, refreshToken: string): Promise<AuthTokens>;
}

export class UsernameExistsError extends Error {
  override name = 'UsernameExistsError';
}
/** Wrong password (NotAuthorizedException and not "user is disabled") */
export class WrongPasswordError extends Error {
  override name = 'WrongPasswordError';
}
export class UserDisabledError extends Error {
  override name = 'UserDisabledError';
}
export class UserNotFoundError extends Error {
  override name = 'UserNotFoundError';
}
/** The refresh token is invalid / revoked */
export class RefreshRejectedError extends Error {
  override name = 'RefreshRejectedError';
}

function errName(e: unknown): string {
  return (e as { name?: string })?.name ?? '';
}

function mapAuthError(e: unknown): never {
  const name = errName(e);
  const msg = (e as Error)?.message ?? '';
  if (name === 'NotAuthorizedException') {
    if (/disabled/i.test(msg)) throw new UserDisabledError('用户已被禁用');
    throw new WrongPasswordError('认证失败');
  }
  if (name === 'UserNotFoundException') throw new UserNotFoundError('用户不存在');
  throw e;
}

export function sdkCognitoApi(client: CognitoIdentityProviderClient, userPoolId: string): CognitoApi {
  return {
    async getUser(username) {
      try {
        const r = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
        return { status: r.UserStatus ?? 'UNKNOWN', enabled: r.Enabled !== false };
      } catch (e) {
        if (errName(e) === 'UserNotFoundException') return null;
        throw e;
      }
    },
    async createUser(username) {
      try {
        await client.send(new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: username, MessageAction: 'SUPPRESS' }));
      } catch (e) {
        if (errName(e) === 'UsernameExistsException') throw new UsernameExistsError(username);
        throw e;
      }
    },
    async setPermanentPassword(username, password) {
      await client.send(
        new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }),
      );
    },
    async passwordAuth(clientId, username, password) {
      try {
        const r = await client.send(
          new AdminInitiateAuthCommand({
            UserPoolId: userPoolId,
            ClientId: clientId,
            AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
            AuthParameters: { USERNAME: username, PASSWORD: password },
          }),
        );
        if (r.ChallengeName) throw new Error(`Cognito 返回了 challenge ${r.ChallengeName}`);
        const a = r.AuthenticationResult;
        if (!a?.AccessToken) throw new Error('Cognito 没有返回 access token');
        return { accessToken: a.AccessToken, refreshToken: a.RefreshToken, expiresInSec: a.ExpiresIn ?? 900 };
      } catch (e) {
        mapAuthError(e);
      }
    },
    async refreshAuth(clientId, refreshToken) {
      try {
        const r = await client.send(
          new AdminInitiateAuthCommand({
            UserPoolId: userPoolId,
            ClientId: clientId,
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            AuthParameters: { REFRESH_TOKEN: refreshToken },
          }),
        );
        const a = r.AuthenticationResult;
        if (!a?.AccessToken) throw new RefreshRejectedError('refresh 没有返回 access token');
        return { accessToken: a.AccessToken, refreshToken: a.RefreshToken, expiresInSec: a.ExpiresIn ?? 900 };
      } catch (e) {
        if (e instanceof RefreshRejectedError) throw e;
        const name = errName(e);
        if (name === 'NotAuthorizedException') {
          if (/disabled/i.test((e as Error).message ?? '')) throw new UserDisabledError('用户已被禁用');
          throw new RefreshRejectedError('refresh token 失效');
        }
        throw e;
      }
    },
  };
}

// ---- app client management (bind / unbind, design 4.6, 10) ----

export const ACCESS_TOKEN_MINUTES = 15;
export const REFRESH_TOKEN_DAYS = 30;

export async function createBindingClient(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  clientName: string,
): Promise<string> {
  const r = await client.send(
    new CreateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientName: clientName.slice(0, 128),
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      AccessTokenValidity: ACCESS_TOKEN_MINUTES,
      IdTokenValidity: ACCESS_TOKEN_MINUTES,
      RefreshTokenValidity: REFRESH_TOKEN_DAYS,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
      // No end-user sign-in, so there is no enumeration risk; LEGACY makes a nonexistent user return UserNotFoundException
      // instead of NotAuthorizedException (otherwise it would be taken as a wrong password and trigger the AWSPREVIOUS fallback).
      PreventUserExistenceErrors: 'LEGACY',
      EnableTokenRevocation: true,
    }),
  );
  const id = r.UserPoolClient?.ClientId;
  if (!id) throw new Error('CreateUserPoolClient 没有返回 ClientId');
  return id;
}

export async function describeBindingClient(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  clientId: string,
): Promise<boolean> {
  try {
    await client.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }));
    return true;
  } catch (e) {
    if (errName(e) === 'ResourceNotFoundException') return false;
    throw e;
  }
}

export async function deleteBindingClient(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  clientId: string,
): Promise<void> {
  try {
    await client.send(new DeleteUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }));
  } catch (e) {
    if (errName(e) === 'ResourceNotFoundException') return; // Already deleted
    throw e;
  }
}
