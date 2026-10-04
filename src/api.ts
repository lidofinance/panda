import { type Config } from "./config.ts";
import { Controller } from "./controller.ts";
import type { SnapshotRestoreResult } from "./controller.ts";
import { deadline, defaultTimeoutMs, json } from "./http.ts";
import type { Checkpoint } from "./storage.ts";
import type { SnapshotRef } from "./snapshots.ts";
import {
  operationId,
  type SnapshotOperation,
  SnapshotOperationError,
  type SnapshotRequest,
} from "./snapshot_operations.ts";
export type { SnapshotRef } from "./snapshots.ts";
export type { SnapshotRestoreResult } from "./controller.ts";
export { SnapshotOperationError } from "./snapshot_operations.ts";
export type { SnapshotOperation } from "./snapshot_operations.ts";
export interface SnapshotOptions {
  operationId?: string;
}
export interface SnapshotStartOptions extends SnapshotOptions {
  /** Owner of the persistent state directory containing this snapshot. */
  id: string;
}

export class SnapshotRequestError extends Error {
  constructor(readonly operationId: string, cause: unknown) {
    super(`Snapshot request ${operationId} has no confirmed outcome: ${String(cause)}`, { cause });
    this.name = "SnapshotRequestError";
  }
}
import type { WarpOptions } from "./time.ts";
export type { WarpMode, WarpOptions } from "./time.ts";

export class SessionChangedError extends Error {
  constructor() {
    super("Panda session changed or entered maintenance; restart the wait for the current session");
  }
}

export class Devnet {
  private controller?: Controller;
  private readonly disconnected = new AbortController();
  private closing?: Promise<void>;
  constructor(readonly url: string) {}
  static async start(config: Partial<Config> = {}): Promise<Devnet> {
    return await Devnet.owned(config, "new");
  }
  /** Open an existing verified checkpoint; never initialize fresh genesis as a fallback. */
  static async open(config: Partial<Config> = {}): Promise<Devnet> {
    return await Devnet.owned(config, "resume");
  }
  static async fromSnapshot(
    snapshot: SnapshotRef | string,
    options: SnapshotStartOptions,
  ): Promise<Devnet> {
    const controller = await Controller.fromSnapshot(
      typeof snapshot === "string" ? snapshot : snapshot.id,
      options.id,
      operationId(options.operationId ?? crypto.randomUUID()),
    );
    return await Devnet.attachOwned(controller, true);
  }
  private static async owned(config: Partial<Config>, mode: "new" | "resume"): Promise<Devnet> {
    const controller = await Controller.start(config, mode);
    return await Devnet.attachOwned(controller, mode === "resume");
  }
  private static async attachOwned(
    controller: Controller,
    preserveOnFailure: boolean,
  ): Promise<Devnet> {
    try {
      const api = new Devnet(controller.serve(0));
      api.controller = controller;
      return api;
    } catch (error) {
      if (preserveOnFailure) await controller.closePreserving();
      else await controller.close();
      throw error;
    }
  }
  private assertOpen(): void {
    if (this.disconnected.signal.aborted) throw this.disconnected.signal.reason;
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.assertOpen();
    return await json(`${this.url}${path}`, {
      ...init,
      signal: AbortSignal.any([
        this.disconnected.signal,
        AbortSignal.timeout(defaultTimeoutMs()),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  }
  private async call<T = unknown>(
    method: string,
    params: unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    return (await this.request<{ result: T }>("/control", {
      method: "POST",
      body: JSON.stringify({ method, params }),
      signal,
    })).result;
  }
  lifecycle(): Promise<ReturnType<Controller["lifecycle"]>> {
    return this.call("lifecycle");
  }
  /** Keep the service and its public URLs available while stopping its clients cleanly. */
  stop(): Promise<Checkpoint> {
    return this.call("stop");
  }
  resume(): Promise<void> {
    return this.call("resume");
  }
  private async snapshotCall<T>(
    method: string,
    params: unknown[],
    id: string,
    request: SnapshotRequest,
  ): Promise<T> {
    try {
      return await this.call<T>(method, params);
    } catch (cause) {
      // Read-only reconciliation after a lost response. Never resend a mutation automatically.
      const operation = await this.snapshotOperation(id).catch(() => undefined);
      if (
        operation && (operation.id !== id || operation.request.kind !== request.kind ||
          operation.request.snapshotId !== request.snapshotId)
      ) throw new SnapshotRequestError(id, cause);
      if (operation?.state === "succeeded") return operation.result as T;
      if (operation) throw new SnapshotOperationError(operation);
      throw new SnapshotRequestError(id, cause);
    }
  }
  createSnapshot(options: SnapshotOptions = {}): Promise<SnapshotRef> {
    const id = operationId(options.operationId ?? crypto.randomUUID());
    return this.snapshotCall("snapshotCreate", [id], id, { kind: "create" });
  }
  restoreSnapshot(
    snapshot: SnapshotRef | string,
    options: SnapshotOptions = {},
  ): Promise<SnapshotRestoreResult> {
    const id = operationId(options.operationId ?? crypto.randomUUID());
    const snapshotId = typeof snapshot === "string" ? snapshot : snapshot.id;
    return this.snapshotCall("snapshotRestore", [snapshotId, id], id, {
      kind: "restore",
      snapshotId,
    });
  }
  listSnapshots(): Promise<SnapshotRef[]> {
    return this.call("snapshotList");
  }
  removeSnapshot(
    snapshot: SnapshotRef | string,
    options: SnapshotOptions = {},
  ): Promise<SnapshotRef> {
    const id = operationId(options.operationId ?? crypto.randomUUID());
    const snapshotId = typeof snapshot === "string" ? snapshot : snapshot.id;
    return this.snapshotCall("snapshotRemove", [snapshotId, id], id, {
      kind: "remove",
      snapshotId,
    });
  }
  snapshotOperation(id: string): Promise<SnapshotOperation | undefined> {
    return this.call("snapshotOperation", [operationId(id)]);
  }
  get beaconUrl(): string {
    return `${this.url}/cl`;
  }
  get validatorUrl(): string {
    return `${this.url}/vc`;
  }
  status(): Promise<
    {
      id: string;
      profile: import("./profiles.ts").ProfileName;
      bake: string;
      bakeKey: string;
      now: number;
      slot: number;
      automine: boolean;
      automineError?: string;
      el: { hash: string; number: string; timestamp: string };
      finality: { data: { finalized: { epoch: string; root: string } } };
    }
  > {
    return this.call("status");
  }
  stepSlot(): Promise<void> {
    return this.call("stepSlot");
  }
  advanceSlots(count: number): Promise<void> {
    return this.call("advanceSlots", [count]);
  }
  advanceEpochs(count: number): Promise<void> {
    return this.call("advanceEpochs", [count]);
  }
  advanceTime(seconds: number, options?: WarpOptions): Promise<void> {
    return this.call("advanceTime", options === undefined ? [seconds] : [seconds, options]);
  }
  advanceTo(timestamp: number | Date, options?: WarpOptions): Promise<void> {
    const seconds = timestamp instanceof Date ? timestamp.getTime() / 1000 : timestamp;
    return this.call("advanceTo", options === undefined ? [seconds] : [seconds, options]);
  }
  skipSlots(count: number): Promise<void> {
    return this.call("skipSlots", [count]);
  }
  setAutomine(enabled: boolean): Promise<void> {
    return this.call("setAutomine", [enabled]);
  }
  importValidator(keystore: string, password: string): Promise<void> {
    return this.call("importValidator", [keystore, password]);
  }
  exitValidator(pubkey: string): Promise<void> {
    return this.call("exitValidator", [pubkey]);
  }
  async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const response = await this.request<{ result: T; error?: { code: number; message: string } }>(
      "",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
    );
    if (response.error) {
      throw new Error(`${method}: ${response.error.message} (${response.error.code})`);
    }
    return response.result;
  }
  async beacon<T = unknown>(path: string): Promise<T> {
    return await this.request(`/cl${path}`);
  }
  private async session(signal?: AbortSignal): Promise<string> {
    const status = await this.call<ReturnType<Controller["lifecycle"]>>("lifecycle", [], signal);
    if (!status.ready || !status.sessionId) throw new SessionChangedError();
    return status.sessionId;
  }
  private async checkSession(expected: string, signal?: AbortSignal): Promise<void> {
    if (await this.session(signal) !== expected) throw new SessionChangedError();
  }
  private async pause(ms: number, signal = this.disconnected.signal): Promise<void> {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout>;
    const stopped = Promise.withResolvers<void>();
    const abort = () => {
      clearTimeout(timer);
      stopped.reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      timer = setTimeout(stopped.resolve, ms);
      await stopped.promise;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async waitResult<T>(session: string, work: Promise<T>, timeoutMs: number): Promise<T> {
    const watch = new AbortController();
    const signal = AbortSignal.any([watch.signal, this.disconnected.signal]);
    const changed = (async (): Promise<never> => {
      for (;;) {
        await this.pause(100, signal);
        await this.checkSession(session, signal);
      }
    })();
    try {
      return await this.bounded(Promise.race([work, changed]), timeoutMs);
    } finally {
      watch.abort();
      await changed.catch(() => {});
    }
  }
  private async bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    this.assertOpen();
    const closed = Promise.withResolvers<never>();
    const cancel = () => closed.reject(this.disconnected.signal.reason);
    this.disconnected.signal.addEventListener("abort", cancel, { once: true });
    try {
      return await deadline(
        Promise.race([work, closed.promise]),
        Math.max(1, timeoutMs),
        "SDK wait",
      );
    } finally {
      this.disconnected.signal.removeEventListener("abort", cancel);
    }
  }
  async advanceUntil(
    predicate: () => Promise<boolean>,
    options: { maxSlots: number; timeoutMs?: number },
  ): Promise<number> {
    if (!Number.isSafeInteger(options.maxSlots) || options.maxSlots < 0) {
      throw new Error("maxSlots must be a non-negative integer");
    }
    const end = performance.now() + (options.timeoutMs ?? defaultTimeoutMs());
    const session = await this.bounded(this.session(), end - performance.now());
    for (let count = 0;; count++) {
      await this.bounded(this.checkSession(session), end - performance.now());
      const done = await this.waitResult(session, predicate(), end - performance.now());
      await this.bounded(this.checkSession(session), end - performance.now());
      if (done) return count;
      if (count === options.maxSlots || performance.now() >= end) {
        throw new Error("advanceUntil limit reached");
      }
      await this.bounded(this.stepSlot(), end - performance.now());
    }
  }
  async waitForService<T>(
    description: string,
    probe: () => Promise<T | undefined>,
    timeoutMs = defaultTimeoutMs(),
  ): Promise<T> {
    const end = performance.now() + timeoutMs;
    const session = await this.bounded(this.session(), timeoutMs);
    let last: unknown;
    let pause = 10;
    while (performance.now() < end) {
      try {
        await this.bounded(this.checkSession(session), end - performance.now());
        const value = await this.waitResult(session, probe(), end - performance.now());
        await this.bounded(this.checkSession(session), end - performance.now());
        if (value !== undefined) return value;
      } catch (error) {
        if (error instanceof SessionChangedError || this.disconnected.signal.aborted) throw error;
        last = error;
      }
      await this.bounded(
        this.pause(Math.min(pause, Math.max(0, end - performance.now()))),
        end - performance.now(),
      );
      pause = Math.min(250, pause * 1.5);
    }
    throw new Error(`Timed out: ${description}${last ? ` (${last})` : ""}`);
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.disconnected.abort(new Error("Panda SDK connection is closed"));
      await this.controller?.close();
    })();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
