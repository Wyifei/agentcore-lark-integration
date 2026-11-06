// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Per-session serial queue (design 5.5). A Strands Agent does not support handling two turns of one session at once, and the runtime does not queue for us either.
 *
 * - While a turn runs, new messages enter that session's in-memory FIFO (limit 5 by default); beyond the limit they are rejected.
 * - Single process, so no cross-process lock is needed.
 * - Shutdown: stop accepting; wait up to 60 seconds for turns in progress, then abort (reason SHUTDOWN); queued ones are told "not executed, please resend".
 */
export type DropReason = 'new_session' | 'shutdown';

export interface Job {
  run(signal: AbortSignal): Promise<void>;
  /** Queue position changed (position N, starting from 1) */
  onQueued?(position: number): void | Promise<void>;
  /** Dropped while queued */
  onDropped?(reason: DropReason): void | Promise<void>;
}

export type EnqueueResult =
  | { status: 'started' }
  | { status: 'queued'; position: number }
  | { status: 'full' }
  | { status: 'closed' };

interface Lane {
  active: { job: Job; ctrl: AbortController; done: Promise<void> } | null;
  pending: Job[];
}

export class ShutdownAbort extends Error {
  override name = 'ShutdownAbort';
}

export class SessionQueues {
  private readonly lanes = new Map<string, Lane>();
  private closed = false;
  onChange: () => void = () => {};

  readonly maxQueued: number;
  private readonly onJobError: (key: string, e: unknown) => void;

  constructor(maxQueued = 5, onJobError: (key: string, e: unknown) => void = () => {}) {
    this.maxQueued = maxQueued;
    this.onJobError = onJobError;
  }

  enqueue(key: string, job: Job): EnqueueResult {
    if (this.closed) return { status: 'closed' };
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { active: null, pending: [] };
      this.lanes.set(key, lane);
    }
    if (!lane.active) {
      this.start(key, lane, job);
      return { status: 'started' };
    }
    if (lane.pending.length >= this.maxQueued) return { status: 'full' };
    lane.pending.push(job);
    const position = lane.pending.length;
    void Promise.resolve(job.onQueued?.(position)).catch(() => {});
    this.onChange();
    return { status: 'queued', position };
  }

  /** /new: drop the queued messages (the turn in progress completes as usual). Returns the number dropped. */
  dropPending(key: string, reason: DropReason = 'new_session'): number {
    const lane = this.lanes.get(key);
    if (!lane) return 0;
    const dropped = lane.pending.splice(0);
    for (const j of dropped) void Promise.resolve(j.onDropped?.(reason)).catch(() => {});
    if (dropped.length) this.onChange();
    return dropped.length;
  }

  queueLength(key: string): number {
    return this.lanes.get(key)?.pending.length ?? 0;
  }

  isBusy(key: string): boolean {
    return !!this.lanes.get(key)?.active;
  }

  /** Statistics of turns in progress + queued, filtered by key prefix (appId|) */
  stats(prefix = ''): { active: number; queued: number } {
    let active = 0;
    let queued = 0;
    for (const [k, l] of this.lanes) {
      if (!k.startsWith(prefix)) continue;
      if (l.active) active++;
      queued += l.pending.length;
    }
    return { active, queued };
  }

  private start(key: string, lane: Lane, job: Job): void {
    const ctrl = new AbortController();
    const done = (async () => {
      try {
        await job.run(ctrl.signal);
      } catch (e) {
        this.onJobError(key, e);
      }
    })().finally(() => this.next(key, lane));
    lane.active = { job, ctrl, done };
    this.onChange();
  }

  private next(key: string, lane: Lane): void {
    lane.active = null;
    const job = this.closed ? undefined : lane.pending.shift();
    if (job) {
      this.start(key, lane, job);
      lane.pending.forEach((j, i) => void Promise.resolve(j.onQueued?.(i + 1)).catch(() => {}));
    } else if (!lane.pending.length) {
      this.lanes.delete(key);
    }
    this.onChange();
  }

  /** Shutdown flow. Wait up to graceMs for turns in progress to finish, then abort. */
  async shutdown(graceMs = 60_000): Promise<void> {
    this.closed = true;
    for (const [key] of this.lanes) this.dropPending(key, 'shutdown');
    const actives = [...this.lanes.values()].map((l) => l.active).filter((a) => a !== null);
    if (!actives.length) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), graceMs)));
    const all = Promise.all(actives.map((a) => a.done)).then(() => 'ok' as const);
    const r = await Promise.race([all, timeout]);
    clearTimeout(timer);
    if (r === 'timeout') {
      for (const a of actives) a.ctrl.abort(new ShutdownAbort('服务重启'));
      // Give interrupted turns a little time to update their cards
      await Promise.race([all, new Promise((res) => setTimeout(res, 5_000))]);
    }
  }
}
