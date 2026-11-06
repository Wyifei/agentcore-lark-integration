// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Common CLI parts: argument parsing, interactive input, AWS clients, and the "needs reload" convention.
 *
 * The CLI is run by the wrapper script as afbot (design 4.7), and afbot cannot use sudo. When a configuration change needs a reload,
 * the CLI exits with EXIT_NEEDS_RELOAD and the wrapper script runs `sudo systemctl reload` (it only suggests restart when the service is not running).
 */
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { createInterface } from 'node:readline/promises';
import { readBotsFile, regionOf, type BotsFile } from '../config/bots-store.ts';
import { isDev, paths } from '../config/paths.ts';

export const EXIT_NEEDS_RELOAD = 100;

export class CliError extends Error {
  override name = 'CliError';
}

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

/** --key value / --key=value / --flag; flags listed in BOOL_FLAGS do not consume the next argument */
export function parseArgs(argv: string[], boolFlags: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!boolFlags.includes(key) && next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

export function flagStr(a: ParsedArgs, name: string): string | undefined {
  const v = a.flags[name];
  if (v === true) throw new CliError(`--${name} 需要一个值`);
  return v;
}

export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new CliError(`需要交互输入（${question.trim()}），但当前不是终端`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  const a = (await ask(`${question} [y/N] `)).toLowerCase();
  return a === 'y' || a === 'yes';
}

export interface CliEnv {
  file: BotsFile;
  region: string;
  cognito: CognitoIdentityProviderClient;
  agentcore: BedrockAgentCoreControlClient;
}

export function loadEnv(): CliEnv {
  const file = readBotsFile(paths.botsJson());
  const region = regionOf(file.settings);
  return {
    file,
    region,
    cognito: new CognitoIdentityProviderClient({ region }),
    agentcore: new BedrockAgentCoreControlClient({ region }),
  };
}

/** Called after changing the configuration: in production the wrapper script reloads; in development mode it only prints a hint */
export function requestReload(): never {
  if (isDev()) {
    console.log('（开发模式）配置已更新；如果服务在运行，向它发送 SIGHUP 或重启 npm run dev。');
    process.exit(0);
  }
  process.exit(EXIT_NEEDS_RELOAD);
}

export function out(s = ''): void {
  process.stdout.write(s + '\n');
}
