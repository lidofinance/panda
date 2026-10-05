/** Public wire types shared by the HTTP client and Panda's controller. */
export type ProfileName = "pectra" | "gloas";
export type WarpMode = "honest" | "fast";
export interface WarpOptions {
  /** Honest executes every duty; fast permits missed duties and inactivity penalties. @default "honest" */
  mode?: WarpMode;
}
/** Completed protocol time advancement. */
export interface TimeState {
  /** Unix seconds with millisecond precision. */
  now: number;
  slot: number;
}
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
/** Native checkpoint receipt; extension fields depend on the checkpoint ABI. */
export interface Checkpoint {
  abi: 1;
  nowMs: number;
  headSlot: number;
  headBlockRoot: string;
  headStateRoot: string;
  forkChoiceSlot: number;
  checkpointHash: string;
  [key: string]: unknown;
}
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
/** Result shape follows the recorded request; a failure may still retain a result. */
export type SnapshotOperation =
  & Omit<SnapshotOperationRecord, "request" | "result">
  & (
    | { request: { kind: "create" | "remove"; snapshotId?: string }; result?: SnapshotRef }
    | { request: { kind: "restore"; snapshotId: string }; result?: SnapshotRestoreResult }
  );
/** Available while clients are running, stopped or faulted. */
export interface LifecycleState {
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
  checkpointCapable: boolean;
  active: number;
  streams: number;
  error?: string;
  operation?: {
    id: string;
    name: string;
    state: "running" | "succeeded" | "failed";
    result?: unknown;
    error?: string;
  };
  cleanup?: SnapshotOperationRecord["cleanup"];
}
/** Latest execution block with transaction hashes and Ethereum hex quantities. */
export interface ExecutionBlock {
  hash: string;
  number: string;
  timestamp: string;
  transactions: string[];
  [key: string]: unknown;
}
export interface FinalityCheckpoint {
  epoch: string;
  root: string;
}
export interface FinalityState {
  data: {
    previous_justified: FinalityCheckpoint;
    current_justified: FinalityCheckpoint;
    finalized: FinalityCheckpoint;
  };
  execution_optimistic?: boolean;
  finalized?: boolean;
}
export interface NetworkStatus extends TimeState {
  id: string;
  profile: ProfileName;
  bake: string;
  bakeKey: string;
  automine: boolean;
  automineError?: string;
  el: ExecutionBlock;
  finality: FinalityState;
}
/** Controller process metrics; excludes native client processes. */
export interface Resources {
  /** Process CPU time in microseconds. */
  cpu: { user: number; system: number };
  /** Memory in bytes. */
  memory: { rss: number; heapTotal: number; heapUsed: number; external: number };
}
/** Wire commands: positional arguments and the value inside the result envelope. */
export interface ControlCommands {
  /** Read protocol time, execution head and Beacon finality. */
  status: { params?: []; result: NetworkStatus };
  /** Inspect readiness, recovery, checkpoint support and session identity. */
  lifecycle: { params?: []; result: LifecycleState };
  /** Read controller CPU and memory usage. */
  resources: { params?: []; result: Resources };
  /** Stop native clients at a checkpoint while HTTP remains available. */
  stop: { params?: []; result: Checkpoint };
  /** Resume checkpointed clients and replace the session identity. */
  resume: { params?: []; result: LifecycleState };
  /** Produce the next slot and complete its duties and tail. */
  stepSlot: { params?: []; result: TimeState };
  /** Advance a non-negative integer count of slots honestly. */
  advanceSlots: { params: [count: number]; result: TimeState };
  /** Advance a non-negative integer count of 32-slot epochs honestly. */
  advanceEpochs: { params: [count: number]; result: TimeState };
  /** Advance by seconds; honest mode is the default. */
  advanceTime: {
    params: [seconds: number] | [seconds: number, options: WarpOptions];
    result: TimeState;
  };
  /** Advance to Unix seconds; the target cannot precede current protocol time. */
  advanceTo: {
    params: [unixSeconds: number] | [unixSeconds: number, options: WarpOptions];
    result: TimeState;
  };
  /** Skip slots as downtime without producing a destination block. */
  skipSlots: { params: [count: number]; result: TimeState };
  /** Enable or disable mining eligible pending transactions. */
  setAutomine: { params: [enabled: boolean]; result: null };
  /** Import one EIP-2335 keystore JSON string with its password. */
  importValidator: { params: [keystore: string, password: string]; result: null };
  /** Sign and submit a voluntary exit for a locally managed 48-byte hex public key. */
  exitValidator: { params: [pubkey: string]; result: null };
  /** Save state at a completed slot tail with an empty transaction pool. Retain the operation UUID. */
  snapshotCreate: { params: [operationId: string]; result: SnapshotRef };
  /** Restore saved state, replace the session and disable automine. Reset external consumers. */
  snapshotRestore: {
    params: [snapshotId: string, operationId: string];
    result: SnapshotRestoreResult;
  };
  /** Delete a saved snapshot without changing the active branch. */
  snapshotRemove: { params: [snapshotId: string, operationId: string]; result: SnapshotRef };
  /** List saved snapshots belonging to this network owner. */
  snapshotList: { params?: []; result: SnapshotRef[] };
  /** Query a durable outcome; an unknown UUID returns an empty response object. */
  snapshotOperation: { params: [operationId: string]; result: SnapshotOperation | undefined };
}
export type CommandName = keyof ControlCommands;
export type CommandParams<K extends CommandName> = NonNullable<ControlCommands[K]["params"]>;
export type CommandResult<K extends CommandName> = ControlCommands[K]["result"];
export type ControlRequest =
  | { [K in CommandName]: { method: K } & Pick<ControlCommands[K], "params"> }[CommandName]
  | { method: "shutdown"; params?: [] };
export type ControlResponse =
  | {
    [K in CommandName]: K extends "snapshotOperation" ? { result?: SnapshotOperation }
      : { result: CommandResult<K> };
  }[CommandName]
  | { id: string };
export interface ControlError {
  error: string;
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

export class HttpError extends Error {
  constructor(readonly status: number, url: string, body: string) {
    super(`${status} ${url}: ${body}`);
  }
}
