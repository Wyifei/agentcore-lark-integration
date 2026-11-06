// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Inter-process file lock: create the lock file with O_EXCL and write the pid; when the holder process no longer exists the lock is considered stale and taken over.
 * Used for the read-modify-write of bots.json and for rotate.lock (design 5.3).
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

export class LockBusyError extends Error {
  override name = 'LockBusyError';
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    let holder = NaN;
    try {
      holder = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    } catch {
      /* Just released */
    }
    if (Number.isFinite(holder) && !pidAlive(holder)) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* Someone else deleted it during the race */
      }
    }
    return false;
  }
}

export interface LockOptions {
  /** Wait limit in milliseconds; 0 means fail immediately if the lock cannot be taken (used by rotate.lock) */
  waitMs?: number;
}

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? 10_000;
  const deadline = Date.now() + waitMs;
  while (!tryAcquire(lockPath)) {
    if (Date.now() >= deadline) throw new LockBusyError(`锁被占用：${lockPath}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}
