import { defaultTimeoutMs } from "./http.ts";
export const SLOT_MS = 12_000;
export const SLOTS_PER_EPOCH = 32;
export const PHASES = [0, 4_000, 6_000, 8_000, 9_000, 11_500] as const;
export type WarpMode = "honest" | "fast";
export interface WarpOptions {
  /** Honest executes every duty; fast permits empty slots and their inactivity penalties. */
  mode?: WarpMode;
}
export function warpMode(options: unknown = {}): WarpMode {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Warp options must be an object");
  }
  const mode = (options as WarpOptions).mode;
  if (mode === undefined) return "honest";
  if (mode !== "honest" && mode !== "fast") throw new Error("Warp mode must be honest or fast");
  return mode;
}
export interface TimeBackend {
  move(nowMs: number, phase?: number): Promise<void>;
  skip?(nowMs: number): Promise<void>;
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  idle(): Promise<unknown> {
    return this.tail;
  }
}
export function integer(value: number, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}
export function milliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(seconds * 1000)) {
    throw new Error("Time must be non-negative seconds, with at most millisecond precision");
  }
  return seconds * 1000;
}
/** Single writer for protocol time. Ambiguous partial progress faults until reset. */
export class Timeline {
  readonly queue = new Serial();
  onFault?: (error: unknown) => void;
  private fault?: unknown;
  private stopped = false;
  constructor(
    readonly genesisMs: number,
    public nowMs: number,
    readonly backend: TimeBackend,
    readonly phases: readonly number[] = PHASES,
  ) {}
  get slot(): number {
    return Math.floor((this.nowMs - this.genesisMs) / SLOT_MS);
  }
  get timestamp(): number {
    return this.nowMs / 1000;
  }
  assertHealthy(): void {
    if (this.stopped) throw new Error("Controller is stopping");
    if (this.fault) throw new Error(`Advancement faulted; reset required: ${this.fault}`);
  }
  stop(): void {
    this.stopped = true;
  }
  private fail(error: unknown): void {
    this.fault = error;
    this.onFault?.(error);
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return await this.queue.run(() => {
      this.assertHealthy();
      return fn();
    });
  }
  private async to(target: number): Promise<void> {
    integer(target, "target milliseconds");
    if (target < this.nowMs) throw new Error("Protocol time can only move forward");
    try {
      while (this.nowMs < target) {
        this.assertHealthy();
        const start = this.genesisMs + this.slot * SLOT_MS;
        const next = this.phases.map((phase) => ({ at: start + phase, phase }))
          .find((entry) => entry.at > this.nowMs) ?? { at: start + SLOT_MS, phase: 0 };
        const at = Math.min(target, next.at);
        await this.backend.move(at, at === next.at ? next.phase : undefined);
        this.nowMs = at;
      }
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  advanceTo(timestamp: number, options?: WarpOptions): Promise<void> {
    const target = milliseconds(timestamp);
    const mode = warpMode(options);
    return this.exclusive(() => this.warpTo(target, mode));
  }
  advanceTime(seconds: number, options?: WarpOptions): Promise<void> {
    const duration = milliseconds(seconds);
    const mode = warpMode(options);
    return this.exclusive(() => this.warpTo(this.nowMs + duration, mode));
  }
  private async warpTo(target: number, mode: WarpMode): Promise<void> {
    integer(target, "target milliseconds");
    if (target < this.nowMs) throw new Error("Protocol time can only move forward");
    const targetSlot = Math.floor((target - this.genesisMs) / SLOT_MS);
    if (mode === "fast" && targetSlot - this.slot > SLOTS_PER_EPOCH) {
      if (!this.backend.skip) throw new Error("This backend does not support fast slot skipping");
      // Preserve the established skip algorithm: complete current duties, restart the VC with
      // its slashing DB at the end of the gap, then produce the destination slot normally.
      await this.to(Math.max(this.nowMs, this.genesisMs + this.slot * SLOT_MS + 11_500));
      const beforeDestination = this.genesisMs + (targetSlot - 1) * SLOT_MS + 11_500;
      try {
        await this.backend.skip(beforeDestination);
        this.nowMs = beforeDestination;
      } catch (error) {
        this.fail(error);
        throw error;
      }
    }
    await this.to(target);
  }
  stepSlot(): Promise<void> {
    return this.advanceSlots(1);
  }
  advanceSlots(count: number): Promise<void> {
    integer(count, "slot count");
    return this.exclusive(() =>
      count === 0
        ? Promise.resolve()
        : this.to(this.genesisMs + (this.slot + count) * SLOT_MS + 11_500)
    );
  }
  advanceEpochs(count: number): Promise<void> {
    integer(count, "epoch count");
    return this.advanceSlots(count * SLOTS_PER_EPOCH);
  }
  advanceUntil(
    condition: () => Promise<boolean>,
    options: { maxSlots: number; timeoutMs?: number },
  ): Promise<number> {
    integer(options.maxSlots, "maxSlots");
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs();
    integer(timeoutMs, "timeoutMs", 1);
    return this.exclusive(async () => {
      const deadline = performance.now() + timeoutMs;
      for (let n = 0;; n++) {
        if (await condition()) return n;
        if (n === options.maxSlots || performance.now() >= deadline) {
          throw new Error("advanceUntil limit reached");
        }
        await this.to(this.genesisMs + (this.slot + 1) * SLOT_MS + 11_500);
      }
    });
  }
  skipSlots(count: number): Promise<void> {
    integer(count, "slot count");
    return this.exclusive(async () => {
      if (!count) return;
      if (!this.backend.skip) throw new Error("This backend does not support slot skipping");
      // Finish current duties before restarting the VC at the end of the skipped range.
      await this.to(Math.max(this.nowMs, this.genesisMs + this.slot * SLOT_MS + 11_500));
      const target = this.nowMs + count * SLOT_MS;
      try {
        await this.backend.skip(target);
        this.nowMs = target;
      } catch (error) {
        this.fail(error);
        throw error;
      }
    });
  }
}
