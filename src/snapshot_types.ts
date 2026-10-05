import type { ConsensusMessage } from "./consensus_messages.ts";
import type { ProfileName } from "./profiles.ts";

export interface SnapshotRef {
  id: string;
  createdAt: string;
  profile: ProfileName;
  bakeKey: string;
  /** Protocol time in milliseconds. */
  nowMs: number;
  headSlot: number;
  headBlockRoot: string;
}
export interface SnapshotRestoreResult {
  snapshot: SnapshotRef;
  generation: string;
  /** Reset external providers and indexers for this replacement session. */
  sessionId: string;
  nowMs: number;
}
export interface SavedState {
  schema: 2;
  nowMs: number;
  slot: number;
  headSlot: number;
  headBlockRoot: string;
  headStateRoot: string;
  executionBlockHash: string;
  executionBlockNumber: number;
  finalizedEpoch: number;
  finalizedRoot: string;
  replayMessages: ConsensusMessage[];
  databaseFiles: Record<"el" | "bn", FileInventory>;
  sharedFiles: Record<"metadata" | "jwt" | "validator-keys", FileInventory>;
}
export type FileInventory = Record<string, { hash: string; size: number }>;
export type CapturedState = Omit<SavedState, "databaseFiles" | "sharedFiles">;
export interface SnapshotRequest {
  kind: "create" | "restore" | "remove";
  snapshotId?: string;
}
/** Stored operation metadata, including partial failure and independent cleanup. */
export interface SnapshotOperationRecord {
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
/** Inspect readiness without requiring live clients. */
export interface SnapshotLifecycle {
  phase: "ready" | "maintenance" | "parked" | "faulted";
  ready: boolean;
  id: string;
  profile: ProfileName;
  bake: string;
  generation?: string;
  sessionId: string;
  now?: number;
  slot?: number;
  recoveryRequired: boolean;
  active: number;
  streams: number;
  operation?: string;
  error?: string;
  cleanup?: { state: "succeeded" | "failed"; error?: string };
}

/** Snapshot/lifecycle subset of POST /control. Other Panda commands remain available. */
export interface SnapshotCommands {
  /** Save and resume at the same time. Supply an operation UUID to recover a lost response. */
  snapshotCreate: { params?: [] | [operationId: string]; result: SnapshotRef };
  /** List this network owner's immutable snapshots. */
  snapshotList: { params?: []; result: SnapshotRef[] };
  /** Restore a reusable ID, change session and disable automine. Parameters: snapshot ID, operation UUID. */
  snapshotRestore: {
    params: [snapshotId: string] | [snapshotId: string, operationId: string];
    result: SnapshotRestoreResult;
  };
  /** Remove only the saved artifact. Parameters: snapshot ID, operation UUID. */
  snapshotRemove: {
    params: [snapshotId: string] | [snapshotId: string, operationId: string];
    result: SnapshotRef;
  };
  /** Recover a durable outcome by operation UUID. An unknown operation returns an empty object. */
  snapshotOperation: { params: [operationId: string]; result?: SnapshotOperationRecord };
  /** Inspect readiness and the current session. */
  lifecycle: { params?: []; result: SnapshotLifecycle };
  /** Cleanly stop and preserve the active network at its completed slot. */
  stop: { params?: []; result: SnapshotLifecycle };
  /** Resume the preserved active network and change session. */
  resume: { params?: []; result: SnapshotLifecycle };
}

/** A failed operation may still contain a published snapshot or authoritative generation. */
export interface SnapshotControlError {
  error: string;
  operation?: SnapshotOperationRecord;
}

/** Shared validation of the caller's durable operation identity. */
export function operationId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
    throw new Error("Snapshot operation requires a UUID operation ID");
  }
  return id;
}
export class SnapshotOperationError extends Error {
  constructor(readonly operation: SnapshotOperationRecord) {
    super(operation.error ?? `Snapshot operation is ${operation.state} at ${operation.stage}`);
    this.name = "SnapshotOperationError";
  }
}
