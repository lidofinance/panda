import { HttpError, operationId, SnapshotOperationError } from "./api_contract.ts";
import type {
  Checkpoint,
  CommandName,
  CommandParams,
  CommandResult,
  LifecycleState,
  NetworkStatus,
  Resources,
  SnapshotOperation,
  SnapshotRef,
  SnapshotRequest,
  SnapshotRestoreResult,
  TimeState,
  WarpOptions,
} from "./api_contract.ts";
export * from "./api_contract.ts";
export interface SnapshotOptions {
  operationId?: string;
}
export class SnapshotRequestError extends Error {
  constructor(readonly operationId: string, cause: unknown) {
    super(`Snapshot request ${operationId} has no confirmed outcome: ${String(cause)}`, { cause });
    this.name = "SnapshotRequestError";
  }
}
export class SessionChangedError extends Error {
  constructor() {
    super("Panda session changed or entered maintenance; restart the wait for the current session");
  }
}

/** HTTP-only connection to an existing Panda service. close() only disconnects this client. */
export class PandaClient {
  protected readonly disconnected = new AbortController();
  private readonly timeoutMs: number;
  constructor(readonly url: string, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_600_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647
    ) {
      throw new Error("timeoutMs must be an integer from 1 to 2147483647");
    }
  }
  protected assertOpen(): void {
    if (this.disconnected.signal.aborted) throw this.disconnected.signal.reason;
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.assertOpen();
    const url = `${this.url}${path}`;
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.any([
        this.disconnected.signal,
        AbortSignal.timeout(this.timeoutMs),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
    if (!response.ok) throw new HttpError(response.status, url, await response.text());
    return await response.json();
  }

  private async call<K extends CommandName>(
    method: K,
    params: CommandParams<K>,
    signal?: AbortSignal,
  ): Promise<CommandResult<K>> {
    return (await this.request<{ result: CommandResult<K> }>("/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
      signal,
    })).result;
  }
  lifecycle(): Promise<LifecycleState> {
    return this.call("lifecycle", []);
  }
  /** Keep the service and its public URLs available while stopping its clients cleanly. */
  stop(): Promise<Checkpoint> {
    return this.call("stop", []);
  }
  resume(): Promise<LifecycleState> {
    return this.call("resume", []);
  }
  private async snapshotCall<K extends "snapshotCreate" | "snapshotRestore" | "snapshotRemove">(
    method: K,
    params: CommandParams<K>,
    id: string,
    request: SnapshotRequest,
  ): Promise<CommandResult<K>> {
    try {
      return await this.call(method, params);
    } catch (cause) {
      // Read-only reconciliation after a lost response. Never resend a mutation automatically.
      const operation = await this.snapshotOperation(id).catch(() => undefined);
      if (
        operation && (operation.id !== id || operation.request.kind !== request.kind ||
          operation.request.snapshotId !== request.snapshotId)
      ) throw new SnapshotRequestError(id, cause);
      if (operation?.state === "succeeded") return operation.result as CommandResult<K>;
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
    return this.call("snapshotList", []);
  }
  /** Stream a saved archive. Consume or cancel the body; verify X-Panda-Sha256 when saving. */
  async downloadSnapshot(snapshot: SnapshotRef | string): Promise<Response> {
    this.assertOpen();
    const id = operationId(typeof snapshot === "string" ? snapshot : snapshot.id);
    const response = await fetch(`${this.url}/snapshots/${id}/archive`, {
      signal: AbortSignal.any([this.disconnected.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Snapshot export: HTTP ${response.status}: ${await response.text()}`);
    }
    return response;
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
  status(): Promise<NetworkStatus> {
    return this.call("status", []);
  }
  resources(): Promise<Resources> {
    return this.call("resources", []);
  }
  stepSlot(): Promise<TimeState> {
    return this.call("stepSlot", []);
  }
  advanceSlots(count: number): Promise<TimeState> {
    return this.call("advanceSlots", [count]);
  }
  advanceEpochs(count: number): Promise<TimeState> {
    return this.call("advanceEpochs", [count]);
  }
  advanceTime(seconds: number, options?: WarpOptions): Promise<TimeState> {
    return this.call("advanceTime", options === undefined ? [seconds] : [seconds, options]);
  }
  advanceTo(timestamp: number | Date, options?: WarpOptions): Promise<TimeState> {
    const seconds = timestamp instanceof Date ? timestamp.getTime() / 1000 : timestamp;
    return this.call("advanceTo", options === undefined ? [seconds] : [seconds, options]);
  }
  skipSlots(count: number): Promise<TimeState> {
    return this.call("skipSlots", [count]);
  }
  setAutomine(enabled: boolean): Promise<null> {
    return this.call("setAutomine", [enabled]);
  }
  importValidator(keystore: string, password: string): Promise<null> {
    return this.call("importValidator", [keystore, password]);
  }
  exitValidator(pubkey: string): Promise<null> {
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
    const status = await this.call("lifecycle", [], signal);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        closed.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Timed out: SDK wait")),
            Math.max(1, timeoutMs),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
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
    const end = performance.now() + (options.timeoutMs ?? this.timeoutMs);
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
    timeoutMs = this.timeoutMs,
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
    this.disconnected.abort(new Error("Panda SDK connection is closed"));
    return Promise.resolve();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
