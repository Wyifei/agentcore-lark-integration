// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/** Event de-duplication (design 5.1): an event_id is a duplicate as soon as the insert finds it, kept for 24 hours. */
import type { Db } from './sqlite.ts';

export const SEEN_RETENTION_MS = 24 * 3600 * 1000;

export class SeenEvents {
  private timer: NodeJS.Timeout | undefined;
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** Returns true the first time it is seen; false for a re-delivered event. */
  markFirstSeen(eventId: string): boolean {
    const r = this.db.run('INSERT OR IGNORE INTO seen_events(event_id, seen_at) VALUES (?, ?)', eventId, this.now());
    return r.changes === 1;
  }

  purge(): number {
    return this.db.run('DELETE FROM seen_events WHERE seen_at < ?', this.now() - SEEN_RETENTION_MS).changes;
  }

  startPurgeTimer(intervalMs = 3600_000): void {
    this.purge();
    this.timer = setInterval(() => this.purge(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
