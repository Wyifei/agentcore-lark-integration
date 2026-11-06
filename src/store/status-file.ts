// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * status.json (design 4.6): written by the service process when the state changes and every 30 seconds; read by the CLI.
 * If it has not been updated for 90 seconds, the CLI shows "the service may not be running".
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

export interface BotStatus {
  appId: string;
  appName: string;
  connection: ConnState;
  since: string;
  activeSessions: number;
  queuedTurns: number;
}

export interface ServiceStatus {
  version: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  bots: BotStatus[];
}

export const STATUS_INTERVAL_MS = 30_000;
export const STATUS_STALE_MS = 90_000;

export class StatusWriter {
  private timer: NodeJS.Timeout | undefined;
  private pending = false;
  private readonly path: string;
  private readonly snapshot: () => Omit<ServiceStatus, 'updatedAt'>;
  constructor(path: string, snapshot: () => Omit<ServiceStatus, 'updatedAt'>) {
    this.path = path;
    this.snapshot = snapshot;
  }

  writeNow(): void {
    const s: ServiceStatus = { ...this.snapshot(), updatedAt: new Date().toISOString() };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Called when the state changes; several changes in the same event loop turn are merged into one write. */
  changed(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.safeWrite();
    });
  }

  start(): void {
    this.safeWrite();
    this.timer = setInterval(() => this.safeWrite(), STATUS_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private safeWrite(): void {
    try {
      this.writeNow();
    } catch {
      /* A failure to write the state does not affect the service */
    }
  }
}

export type StatusRead =
  | { kind: 'missing' }
  | { kind: 'stale'; status: ServiceStatus; ageMs: number }
  | { kind: 'fresh'; status: ServiceStatus; ageMs: number };

export function readStatus(path: string, now = Date.now()): StatusRead {
  let s: ServiceStatus;
  try {
    s = JSON.parse(readFileSync(path, 'utf8')) as ServiceStatus;
  } catch {
    return { kind: 'missing' };
  }
  const ageMs = now - Date.parse(s.updatedAt);
  return ageMs > STATUS_STALE_MS || !Number.isFinite(ageMs) ? { kind: 'stale', status: s, ageMs } : { kind: 'fresh', status: s, ageMs };
}
