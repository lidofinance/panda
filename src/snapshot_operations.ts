import { join } from "node:path";
import { canonical } from "./profiles.ts";
import type { SnapshotRef, SnapshotStore } from "./snapshots.ts";
import { durableJson, StateLock, StateStore } from "./storage.ts";

export interface SnapshotRequest {
  kind: "create" | "restore" | "remove";
  snapshotId?: string;
}
export interface SnapshotOperation {
  schema: 1;
  owner: string;
  id: string;
  request: SnapshotRequest;
  state: "running" | "succeeded" | "failed";
  stage: string;
  createdAt: string;
  updatedAt: string;
  snapshot?: SnapshotRef;
  sourceGeneration?: string;
  candidateGeneration?: string;
  automine?: boolean;
  result?: unknown;
  error?: string;
  cleanup?: { state: "pending" | "succeeded" | "failed"; error?: string };
}

export function operationId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
    throw new Error("Snapshot operation requires a UUID operation ID");
  }
  return id;
}

export class SnapshotOperationError extends Error {
  constructor(readonly operation: SnapshotOperation) {
    super(operation.error ?? `Snapshot operation is ${operation.state} at ${operation.stage}`);
    this.name = "SnapshotOperationError";
  }
}

/** Per-request durable outcomes survive HTTP response loss and controller process exit. */
export class SnapshotJournal {
  constructor(readonly store: StateStore) {}

  async list(): Promise<SnapshotOperation[]> {
    let path: string;
    try {
      path = await this.directory(false);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    const result: SnapshotOperation[] = [];
    for await (const entry of Deno.readDir(path)) {
      if (entry.name.endsWith(".tmp")) continue;
      if (!entry.name.endsWith(".json")) throw new Error("Unexpected snapshot operation entry");
      const record = await this.read(entry.name.slice(0, -5));
      if (record) result.push(record);
    }
    return result;
  }

  /** Shared live/offline removal; the journal lock also excludes a restore using this archive. */
  remove(snapshots: SnapshotStore, snapshotId: string, id: string): Promise<SnapshotRef> {
    if (snapshots.store.id !== this.store.id || snapshots.store.root !== this.store.root) {
      return Promise.reject(new Error("Snapshot removal ownership mismatch"));
    }
    return this.run(id, { kind: "remove", snapshotId }, async (record) => {
      const snapshot = await snapshots.remove(snapshotId, async (snapshot) => {
        await this.update(record, { stage: "removing", snapshot });
      });
      await this.update(record, { stage: "removed", result: snapshot });
      return snapshot;
    });
  }

  private async directory(create: boolean): Promise<string> {
    await this.store.snapshotsDirectory();
    const path = join(this.store.root, "operations");
    if (create) {
      try {
        await Deno.mkdir(path, { mode: 0o700 });
        using root = await Deno.open(this.store.root, { read: true });
        await root.sync();
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
    }
    const info = await Deno.lstat(path);
    if (!info.isDirectory || info.isSymlink) throw new Error("Unsafe snapshot operation directory");
    return path;
  }

  async read(id: string): Promise<SnapshotOperation | undefined> {
    operationId(id);
    try {
      const path = join(await this.directory(false), `${id}.json`);
      const info = await Deno.lstat(path);
      if (!info.isFile || info.isSymlink) throw new Error("Unsafe snapshot operation record");
      const value = JSON.parse(await Deno.readTextFile(path)) as SnapshotOperation;
      if (
        value.schema !== 1 || value.owner !== this.store.id || value.id !== id ||
        !["create", "restore", "remove"].includes(value.request?.kind) ||
        !["running", "succeeded", "failed"].includes(value.state)
      ) throw new Error("Invalid snapshot operation record");
      return value;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  }

  outcome<T>(record: SnapshotOperation, request: SnapshotRequest): T {
    if (canonical(record.request) !== canonical(request)) {
      throw new Error("Snapshot operation ID already belongs to a different request");
    }
    if (record.state !== "succeeded") throw new SnapshotOperationError(record);
    return record.result as T;
  }

  async update(record: SnapshotOperation, changes: Partial<SnapshotOperation>): Promise<void> {
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    await durableJson(join(await this.directory(true), `${operationId(record.id)}.json`), record);
  }

  async run<T>(
    id: string,
    request: SnapshotRequest,
    work: (record: SnapshotOperation, interrupted: boolean) => Promise<T>,
  ): Promise<T> {
    operationId(id);
    await this.store.snapshotsDirectory();
    const lock = await StateLock.acquire(join(this.store.root, "snapshot-operation.lock"));
    try {
      const previous = await this.read(id);
      if (previous && canonical(previous.request) !== canonical(request)) {
        throw new Error("Snapshot operation ID already belongs to a different request");
      }
      if (previous && previous.state !== "running") return this.outcome<T>(previous, request);
      const record: SnapshotOperation = previous ?? {
        schema: 1,
        owner: this.store.id,
        id,
        request,
        state: "running",
        stage: "accepted",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!previous) await this.update(record, {});
      try {
        const result = await work(record, previous !== undefined);
        await this.update(record, { state: "succeeded", stage: "completed", result });
        return result;
      } catch (error) {
        await this.update(record, { state: "failed", error: String(error) });
        throw new SnapshotOperationError(record);
      }
    } finally {
      lock.release();
    }
  }
}
