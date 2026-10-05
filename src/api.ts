import { type Config } from "./config.ts";
import { Controller } from "./controller.ts";
import { defaultTimeoutMs, json, rpc, waitFor } from "./http.ts";
import type { WarpOptions } from "./time.ts";
export type { WarpMode, WarpOptions } from "./time.ts";

import type {
  SnapshotOperationRecord,
  SnapshotRef,
  SnapshotRestoreResult,
} from "./snapshot_types.ts";
import { SnapshotOperationError } from "./snapshot_types.ts";
import { saveSnapshotStream, type SnapshotImportOptions } from "./snapshot_archive.ts";
export type { SnapshotRef, SnapshotRestoreResult } from "./snapshot_types.ts";

export class Devnet {
  private controller?: Controller;
  constructor(readonly url: string) {}
  static async start(config: Partial<Config> = {}): Promise<Devnet> {
    const controller = await Controller.start(config);
    try {
      const api = new Devnet(controller.serve(0));
      api.controller = controller;
      return api;
    } catch (error) {
      await controller.close();
      throw error;
    }
  }
  private async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(`${this.url}/control`, {
      method: "POST",
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(defaultTimeoutMs()),
    });
    const body = await response.json();
    if (!response.ok) {
      if (body.operation) throw new SnapshotOperationError(body.operation);
      throw new Error(body.error ?? `Control HTTP ${response.status}`);
    }
    return body.result;
  }
  static async fromSnapshot(
    source: string,
    config: Partial<Config> = {},
    options: SnapshotImportOptions = {},
  ): Promise<Devnet> {
    const controller = await Controller.fromSnapshot(source, config, options);
    try {
      const api = new Devnet(controller.serve(0));
      api.controller = controller;
      return api;
    } catch (error) {
      await controller.close();
      throw error;
    }
  }
  lifecycle(): Promise<ReturnType<Controller["lifecycle"]>> {
    return this.call("lifecycle");
  }
  createSnapshot(operationId: string = crypto.randomUUID()): Promise<SnapshotRef> {
    return this.call("snapshotCreate", [operationId]);
  }
  listSnapshots(): Promise<SnapshotRef[]> {
    return this.call("snapshotList");
  }
  restoreSnapshot(
    snapshot: SnapshotRef | string,
    operationId: string = crypto.randomUUID(),
  ): Promise<SnapshotRestoreResult> {
    return this.call("snapshotRestore", [
      typeof snapshot === "string" ? snapshot : snapshot.id,
      operationId,
    ]);
  }
  removeSnapshot(
    snapshot: SnapshotRef | string,
    operationId: string = crypto.randomUUID(),
  ): Promise<SnapshotRef> {
    return this.call("snapshotRemove", [
      typeof snapshot === "string" ? snapshot : snapshot.id,
      operationId,
    ]);
  }
  snapshotOperation(id: string): Promise<SnapshotOperationRecord | undefined> {
    return this.call("snapshotOperation", [id]);
  }
  async exportSnapshot(snapshot: SnapshotRef | string, path: string) {
    const id = typeof snapshot === "string" ? snapshot : snapshot.id;
    const response = await fetch(`${this.url}/snapshots/${id}/archive`, {
      signal: AbortSignal.timeout(defaultTimeoutMs()),
    });
    if (!response.ok || !response.body) throw new Error(`Snapshot export HTTP ${response.status}`);
    return await saveSnapshotStream(response.body, path, {
      sha256: response.headers.get("x-panda-sha256") ?? undefined,
    });
  }
  stop(): Promise<ReturnType<Controller["lifecycle"]>> {
    return this.call("stop");
  }
  resume(): Promise<ReturnType<Controller["lifecycle"]>> {
    return this.call("resume");
  }
  status(): Promise<
    {
      id: string;
      profile: import("./profiles.ts").ProfileName;
      bake: string;
      bakeKey: string;
      sessionId: string;
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
  rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return rpc(this.url, method, params);
  }
  async beacon<T = unknown>(path: string): Promise<T> {
    return await json(`${this.url}${path}`);
  }
  async advanceUntil(
    predicate: () => Promise<boolean>,
    options: { maxSlots: number; timeoutMs?: number },
  ): Promise<number> {
    if (!Number.isSafeInteger(options.maxSlots) || options.maxSlots < 0) {
      throw new Error("maxSlots must be a non-negative integer");
    }
    const deadline = performance.now() + (options.timeoutMs ?? defaultTimeoutMs());
    for (let count = 0;; count++) {
      if (await predicate()) return count;
      if (count === options.maxSlots || performance.now() >= deadline) {
        throw new Error("advanceUntil limit reached");
      }
      await this.stepSlot();
    }
  }
  waitForService<T>(
    description: string,
    probe: () => Promise<T | undefined>,
    timeoutMs = defaultTimeoutMs(),
  ): Promise<T> {
    return waitFor(description, probe, timeoutMs);
  }
  async close(): Promise<void> {
    await this.controller?.close();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
