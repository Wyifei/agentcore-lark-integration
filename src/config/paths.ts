// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { join } from 'node:path';

/** Data directory: /var/lib/agentcore-feishu-bot in production; AFB_DATA_DIR for local development (design 4.7, 10). */
export function dataDir(): string {
  return process.env.AFB_DATA_DIR || '/var/lib/agentcore-feishu-bot';
}

export const paths = {
  botsJson: () => join(dataDir(), 'bots.json'),
  dataDb: () => join(dataDir(), 'data.db'),
  statusJson: () => join(dataDir(), 'status.json'),
  rotateLock: () => join(dataDir(), 'rotate.lock'),
  serveLog: () => process.env.AFB_LOG_FILE || '/var/log/agentcore-feishu-bot/serve.log',
};

export const SERVICE_NAME = 'agentcore-feishu-bot';

/** Local development mode: systemctl is not called. */
export function isDev(): boolean {
  return process.env.AFB_DEV === '1';
}

export const VERSION: string = process.env.AFB_VERSION || '0.1.0-dev';
