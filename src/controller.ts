import { Automine } from "./automine.ts";
import { Consensus } from "./consensus.ts";
import { type Config, configuration } from "./config.ts";
import { deadline, defaultTimeoutMs, json, rpc, waitFor, withWatchdog } from "./http.ts";
import { AdmissionLedger } from "./admission.ts";
import { Ingress } from "./ingress.ts";
import { type ActiveGeneration, type Checkpoint, durableJson, StateStore } from "./storage.ts";
import { type Manifest, Network } from "./network.ts";
import { type SnapshotRef, SnapshotStore } from "./snapshots.ts";
import {
  operationId,
  SnapshotJournal,
  type SnapshotOperation,
  type SnapshotRequest,
} from "./snapshot_operations.ts";
import { type Bake, canonical } from "./profiles.ts";
import { type Timeline, warpMode } from "./time.ts";
import { cpuUsage } from "node:process";
import { exitValidator, importValidator } from "./validators.ts";

interface Session {
  id: string;
  network: Network;
  manifest: Manifest;
  time: Timeline;
  automine: Automine;
  admission?: AdmissionLedger;
}
interface RecoverySession {
  id: string;
  network: Network;
  bake: Bake;
}

interface LifecycleOperation {
  id: string;
  name: string;
  state: "running" | "succeeded" | "failed";
  result?: unknown;
  error?: string;
}
export interface SnapshotRestoreResult {
  snapshot: SnapshotRef;
  generation: string;
  sessionId: string;
  nowMs: number;
}

function rejectForeignRequest(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    return new Response("Forbidden host", { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("Forbidden origin", { status: 403 });
}

/** A stalled upload must not outlive the request drain or server shutdown. */
async function requestText(request: Request, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    aborted.reject(signal.reason);
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted.promise]);
      signal.throwIfAborted();
      if (next.done) return text + decoder.decode();
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export class Controller {
  readonly ingress = new Ingress();
  server?: Deno.HttpServer<Deno.NetAddr>;
  private readonly clientServers: Deno.HttpServer<Deno.NetAddr>[] = [];
  private readonly serverAbort = new AbortController();
  private closing?: Promise<void>;
  private preserving?: Promise<void>;
  private lifecycleWork?: Promise<unknown>;
  private lifecyclePending = false;
  private session: Session | RecoverySession;
  private operation?: LifecycleOperation;
  private readonly snapshotJobs = new Map<
    string,
    { request: SnapshotRequest; work: Promise<unknown> }
  >();
  private get snapshots(): SnapshotStore {
    return new SnapshotStore(this.network.store, this.network.infra);
  }
  private get snapshotJournal(): SnapshotJournal {
    return new SnapshotJournal(this.network.store);
  }
  constructor(
    network: Network,
    manifest: Manifest | Bake,
    time?: Timeline,
    admission?: AdmissionLedger,
  ) {
    if ("recipe" in manifest) {
      this.session = { id: crypto.randomUUID(), network, bake: manifest };
      this.ingress.fault(new Error("Panda requires explicit snapshot recovery"));
    } else {
      if (!time) throw new Error("Running session requires its real Timeline");
      this.session = {
        id: crypto.randomUUID(),
        network,
        manifest,
        time,
        admission,
        automine: new Automine(manifest.el, time),
      };
      this.watchTimeline();
    }
  }
  private get running(): Session {
    if (!("manifest" in this.session)) throw new Error("Panda requires explicit snapshot recovery");
    return this.session;
  }
  private get config(): Config {
    return "manifest" in this.session ? this.session.manifest.config : this.session.network.config;
  }
  private get bake(): Bake {
    return "manifest" in this.session ? this.session.manifest.bake : this.session.bake;
  }
  private watchTimeline(): void {
    const time = this.time;
    time.onFault = (error) => {
      if (this.time === time) this.ingress.fault(error);
    };
  }
  get network() {
    return this.session.network;
  }
  get manifest() {
    return this.running.manifest;
  }
  get time() {
    return this.running.time;
  }
  get automine() {
    return this.running.automine;
  }
  private get checkpointCapable(): boolean {
    return this.config.mode === "controlled" && this.bake?.recipe.checkpointAbi === 1;
  }

  private static async open(
    network: Network,
    mode: "new" | "resume" | "auto",
    signal?: AbortSignal,
    candidate?: { generation: ActiveGeneration; commit: (session: Session) => Promise<void> },
  ): Promise<Session> {
    const manifest = candidate
      ? await network.startCandidate(candidate.generation, signal)
      : await network.start(mode, signal);
    const saved = network.generation?.checkpoint;
    let time: Timeline | undefined;
    try {
      signal?.throwIfAborted();
      const admission = await AdmissionLedger.open(
        `${network.store.generationPath(manifest.generation!)}/admission.json`,
        { gethRevision: manifest.bake.source.el ?? "unknown", create: !saved },
      );
      signal?.throwIfAborted();
      time = await Consensus.connect(manifest, network.engine, signal);
      signal?.throwIfAborted();
      const session = {
        id: crypto.randomUUID(),
        network,
        manifest,
        time,
        admission,
        automine: new Automine(manifest.el, time),
      };
      if (saved) {
        // Parked duties do not imply startup database maintenance has drained yet.
        for (const endpoint of [manifest.bnClock, manifest.vcClock]) {
          const clock = await json<{ parked: boolean; activeWork: number; nowMs: number }>(
            `${endpoint}/park`,
            { method: "POST", signal: withWatchdog(signal) },
          );
          signal?.throwIfAborted();
          if (!clock.parked || clock.activeWork !== 0 || clock.nowMs !== saved.nowMs) {
            throw new Error("Restored client has not drained at its parked checkpoint");
          }
        }
        const native = await json<Checkpoint>(`${manifest.beacon}/lighthouse/panda/checkpoint`, {
          signal: withWatchdog(signal),
        });
        signal?.throwIfAborted();
        if (
          native.checkpointHash !== saved.checkpointHash || native.nowMs !== saved.nowMs ||
          time.nowMs !== saved.nowMs
        ) throw new Error("Native checkpoint receipt mismatch");
        const head = await json<
          { data: { root: string; header: { message: { slot: string; state_root: string } } } }
        >(
          `${manifest.beacon}/eth/v1/beacon/headers/head`,
          { signal: withWatchdog(signal) },
        );
        signal?.throwIfAborted();
        const el = await rpc<{ hash: string }>(manifest.el, "eth_getBlockByNumber", [
          "latest",
          false,
        ], withWatchdog(signal));
        signal?.throwIfAborted();
        if (
          head.data.root !== saved.headBlockRoot ||
          head.data.header.message.state_root !== saved.headStateRoot ||
          Number(head.data.header.message.slot) !== saved.headSlot ||
          el.hash !== saved.executionHash
        ) {
          throw new Error("Restored EL/BN anchors disagree with the checkpoint");
        }
        if (candidate) await candidate.commit(session);
        signal?.throwIfAborted();
        await json(`${manifest.bnClock}/resume`, { method: "POST", signal: withWatchdog(signal) });
        signal?.throwIfAborted();
        await json(`${manifest.vcClock}/resume`, { method: "POST", signal: withWatchdog(signal) });
        signal?.throwIfAborted();
        await waitFor(
          "resumed validator services",
          async (signal) => {
            const clock = await json<{ marks: Record<string, number> }>(manifest.vcClock, {
              signal: withWatchdog(signal),
            });
            return clock.marks.ready === 0 && clock.marks.indices !== undefined ? true : undefined;
          },
          defaultTimeoutMs(),
          signal,
        );
      }
      signal?.throwIfAborted();
      await network.setPhase("running");
      signal?.throwIfAborted();
      return session;
    } catch (error) {
      time?.stop();
      if (saved) await network.fail(error);
      else await network.stop();
      throw error;
    }
  }
  static async start(
    input: Partial<Config> = {},
    mode: "new" | "resume" | "auto" = "new",
    signal?: AbortSignal,
  ): Promise<Controller> {
    signal?.throwIfAborted();
    const requested = configuration(input);
    const active = mode === "auto" ? await new StateStore(requested.id).active() : undefined;
    if (active) {
      for (const [key, value] of Object.entries(input)) {
        if (
          value !== undefined && canonical(value) !== canonical(active.config[key as keyof Config])
        ) {
          throw new Error(`Stored configuration cannot be overridden: ${key}`);
        }
      }
    }
    const config = active?.config ?? requested;
    const recovery = async () => {
      const network = new Network(config);
      return new Controller(network, await network.enterRecovery(signal));
    };
    if (active && active.phase !== "stopped") return await recovery();
    try {
      const session = await Controller.open(new Network(config), mode, signal);
      const controller = new Controller(session.network, session.manifest, session.time);
      controller.session = session;
      return controller;
    } catch (error) {
      signal?.throwIfAborted();
      // A verified resume can still fail its native/byte readback. Keep the service recoverable,
      // but do not turn a failed fresh genesis or a foreign live owner into a recovery service.
      const failed = mode === "auto" ? await new StateStore(config.id).active() : undefined;
      if (failed?.phase === "faulted") return await recovery();
      throw error;
    }
  }
  static async fromSnapshot(
    snapshotId: string,
    id: string,
    requestId = crypto.randomUUID() as string,
  ): Promise<Controller> {
    const store = new StateStore(id);
    const reader = new SnapshotStore(store, new Network(configuration({ id })).infra);
    const snapshot = await reader.read(snapshotId);
    const network = new Network(configuration(snapshot.config));
    const controller = new Controller(network, await network.enterRecovery());
    try {
      await controller.restoreSnapshot(snapshotId, requestId);
      if (controller.lifecycle().recoveryRequired) {
        throw new Error(
          "Snapshot operation already completed in an earlier session; start with a new operation ID",
        );
      }
      return controller;
    } catch (error) {
      try {
        if (controller.ingress.status.ready) await controller.closePreserving();
      } finally {
        network.releaseRecovery();
      }
      throw error;
    }
  }
  /** Inspect a stopped/crashed owner through HTTP; selecting an archive remains explicit. */
  static async recover(id: string, signal?: AbortSignal): Promise<Controller> {
    const active = await new StateStore(id).active();
    if (!active) {
      throw new Error("No active generation; use snapshot open <id> with a saved artifact");
    }
    const network = new Network(active.config);
    return new Controller(network, await network.enterRecovery(signal));
  }
  lifecycle() {
    return {
      ...this.ingress.status,
      id: this.config.id,
      profile: this.config.profile,
      bake: this.config.bake,
      generation: this.network.generation?.generation,
      sessionId: this.session.id,
      now: "time" in this.session ? this.session.time.timestamp : undefined,
      slot: "time" in this.session ? this.session.time.slot : undefined,
      recoveryRequired: !("manifest" in this.session),
      operation: this.operation,
      checkpointCapable: this.checkpointCapable,
    };
  }
  private lifecycleOperation<T>(
    name: string,
    run: () => Promise<T>,
    id?: string,
    shutdown = false,
  ): Promise<T> {
    return this.reserveLifecycle(() => this.performLifecycleOperation(name, run, id), shutdown);
  }
  private reserveLifecycle<T>(run: () => Promise<T>, shutdown = false): Promise<T> {
    if (this.lifecyclePending) {
      return Promise.reject(new Error("Another lifecycle operation is in progress"));
    }
    if (this.closing || this.preserving && !shutdown) {
      return Promise.reject(new Error("Controller is stopping"));
    }
    this.lifecyclePending = true;
    const work = (async () => {
      try {
        return await run();
      } finally {
        this.lifecyclePending = false;
      }
    })();
    this.lifecycleWork = work;
    const finished = () => {
      if (this.lifecycleWork === work) this.lifecycleWork = undefined;
    };
    void work.then(finished, finished);
    return work;
  }
  private async performLifecycleOperation<T>(
    name: string,
    run: () => Promise<T>,
    id = crypto.randomUUID() as string,
    discard = false,
  ): Promise<T> {
    const operation: LifecycleOperation = { id, name, state: "running" };
    this.operation = operation;
    try {
      return await this.ingress.maintenance(
        name,
        async () => {
          await durableJson(`${this.network.store.root}/operation.json`, operation);
          const result = await run();
          operation.state = "succeeded";
          operation.result = result ?? null;
          await durableJson(`${this.network.store.root}/operation.json`, operation);
          return result;
        },
        defaultTimeoutMs(),
        discard
          ? async () => {
            const reason = new Error("Panda session discarded by snapshot restore");
            this.ingress.cancelPending(reason);
            if ("time" in this.session) {
              this.time.stop();
              await this.automine.stop();
              await deadline(
                this.time.queue.idle(),
                defaultTimeoutMs(),
                "discarded Timeline drain",
              );
            }
          }
          : undefined,
      );
    } catch (error) {
      // Drain can fail before the callback runs. Its failure must be visible too.
      this.operation = { ...operation, state: "failed", error: String(error) };
      await durableJson(`${this.network.store.root}/operation.json`, this.operation);
      throw error;
    }
  }
  private async checkpointSession(onNativeChange: () => void): Promise<Checkpoint> {
    const { network, manifest, time, automine, admission } = this.running;
    await deadline(automine.set(false), defaultTimeoutMs(), "automine drain");
    await deadline(time.queue.idle(), defaultTimeoutMs(), "timeline drain");
    time.assertHealthy();
    if ((time.nowMs - time.genesisMs) % 12_000 !== 11_500) {
      throw new Error("Checkpoint requires a completed slot tail; time was not advanced");
    }
    if (!admission) throw new Error("Session has no managed admission history");
    await admission.reconcile((method, args) => rpc(manifest.el, method, args));
    admission.assertSettled();
    const pool = await rpc<{ pending: string; queued: string }>(manifest.el, "txpool_status");
    if (BigInt(pool.pending) !== 0n || BigInt(pool.queued) !== 0n) {
      throw new Error("Checkpoint blocked by pending or queued execution transactions");
    }
    onNativeChange();
    for (const endpoint of [manifest.vcClock, manifest.bnClock]) {
      const clock = await json<{ parked: boolean; activeWork: number; nowMs: number }>(
        `${endpoint}/park`,
        { method: "POST" },
      );
      if (!clock.parked || clock.activeWork !== 0 || clock.nowMs !== time.nowMs) {
        throw new Error("Client did not reach the parked checkpoint boundary");
      }
    }
    const receipt = await json<Checkpoint>(`${manifest.beacon}/lighthouse/panda/checkpoint`, {
      method: "POST",
    });
    if (receipt.abi !== 1 || receipt.nowMs !== time.nowMs || receipt.headSlot !== time.slot) {
      throw new Error("Native checkpoint time/head mismatch");
    }
    const readback = await json<Checkpoint>(`${manifest.beacon}/lighthouse/panda/checkpoint`);
    if (JSON.stringify(receipt) !== JSON.stringify(readback)) {
      throw new Error("Checkpoint readback mismatch");
    }
    const el = await rpc<{ hash: string }>(manifest.el, "eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    if (time.slot > 0) await new Consensus(manifest, network.engine).consistency(time.slot);
    const checkpoint = { ...receipt, executionHash: el.hash };
    await network.preserve(checkpoint);
    time.stop();
    return checkpoint;
  }
  private async resumeSession(): Promise<void> {
    const next = await Controller.open(new Network(this.manifest.config), "resume");
    this.session = next;
    this.watchTimeline();
  }
  async preserve(): Promise<Checkpoint> {
    return await this.preserveSession(false);
  }
  private async preserveSession(shutdown: boolean): Promise<Checkpoint> {
    // Reject unsupported artifacts before closing ingress or changing protocol/client state.
    if (!this.checkpointCapable) {
      throw new Error("Session has no controlled checkpoint capability");
    }
    const wasAutomining = this.automine.enabled;
    let nativeChanged = false;
    try {
      return await this.lifecycleOperation(
        "stop",
        async () => {
          return await this.checkpointSession(() => {
            nativeChanged = true;
          });
        },
        undefined,
        shutdown,
      );
    } catch (error) {
      // A refused save has not changed client state. Keep the admitted work usable so the
      // caller can mine it and retry; uncertain native progress remains closed and faulted.
      if (
        !nativeChanged && !this.lifecyclePending && this.network.generation?.phase === "running"
      ) {
        try {
          this.time.assertHealthy();
          this.ingress.resume();
          await this.automine.set(wasAutomining);
        } catch { /* A failed drain/Timeline cannot be safely reopened. */ }
      }
      throw error;
    }
  }
  async resume(): Promise<void> {
    if (!("manifest" in this.session)) throw new Error("Panda requires explicit snapshot recovery");
    if (this.ingress.status.ready) throw new Error("Network is already running");
    await this.lifecycleOperation("resume", async () => {
      await this.resumeSession();
      return {
        sessionId: this.session.id,
        generation: this.manifest.generation,
        nowMs: this.time.nowMs,
      };
    });
    this.ingress.resume();
  }
  createSnapshot(id: string): Promise<SnapshotRef> {
    operationId(id);
    if (!this.checkpointCapable) {
      return Promise.reject(new Error("Session has no controlled checkpoint capability"));
    }
    return this.snapshotWork(id, { kind: "create" }, () => this.performSnapshotCreate(id));
  }
  private snapshotWork<T>(id: string, request: SnapshotRequest, run: () => Promise<T>): Promise<T> {
    operationId(id);
    if (this.closing || this.preserving) return Promise.reject(new Error("Controller is stopping"));
    const pending = this.snapshotJobs.get(id);
    if (pending) {
      if (canonical(pending.request) !== canonical(request)) {
        return Promise.reject(
          new Error("Snapshot operation ID already belongs to a different request"),
        );
      }
      return pending.work as Promise<T>;
    }
    const work = run();
    this.snapshotJobs.set(id, { request, work });
    const finished = () => this.snapshotJobs.delete(id);
    void work.then(finished, finished);
    return work;
  }
  restoreSnapshot(snapshotId: string, id: string): Promise<SnapshotRestoreResult> {
    const request: SnapshotRequest = { kind: "restore", snapshotId };
    return this.snapshotWork(id, request, async () => {
      const journal = this.snapshotJournal;
      const previous = await journal.read(id);
      if (previous && previous.state !== "running") return journal.outcome(previous, request);
      return await this.reserveLifecycle(() =>
        journal.run(id, request, async (record, interrupted) => {
          if (interrupted) {
            throw new Error(
              "Snapshot restore was interrupted; inspect its stage and active generation, then explicitly restore with a new operation ID",
            );
          }
          const snapshot = (await this.snapshots.read(snapshotId, this.bake, this.config))
            .snapshot;
          await journal.update(record, {
            stage: "preparing",
            snapshot,
            sourceGeneration: (await this.network.store.active())?.generation,
          });
          const candidate = await this.snapshots.prepare(
            snapshotId,
            this.bake,
            this.config,
            async (value) => {
              await journal.update(record, { candidateGeneration: value.generation });
            },
          );
          await journal.update(record, { stage: "prepared" });
          // Cancellation is already a branch mutation: record it before the maintenance drain.
          await journal.update(record, { stage: "source-stopping" });
          const result = await this.performLifecycleOperation(
            "snapshotRestore",
            async () => {
              await this.network.discard();
              await journal.update(record, { stage: "source-stopped" });
              const next = await Controller.open(
                new Network(this.config),
                "resume",
                undefined,
                {
                  generation: candidate,
                  commit: async (session) => {
                    await journal.update(record, { stage: "candidate-verified" });
                    try {
                      await session.network.commitCandidate();
                    } finally {
                      if (
                        (await session.network.store.active())?.generation === candidate.generation
                      ) {
                        // Preserve the new authority even if publication or unpark acknowledgement
                        // fails. A later explicit restore must never resurrect the old branch.
                        this.session = session;
                        this.watchTimeline();
                      }
                    }
                    await journal.update(record, { stage: "committed" });
                  },
                },
              );
              this.session = next;
              this.watchTimeline();
              return {
                snapshot,
                generation: candidate.generation,
                sessionId: next.id,
                nowMs: next.time.nowMs,
              };
            },
            id,
            true,
          );
          this.ingress.resume();
          await journal.update(record, { stage: "published", result });
          return result;
        })
      );
    });
  }
  removeSnapshot(snapshotId: string, id: string): Promise<SnapshotRef> {
    const request: SnapshotRequest = { kind: "remove", snapshotId };
    return this.snapshotWork(id, request, async () => {
      const journal = this.snapshotJournal;
      const previous = await journal.read(id);
      if (previous && previous.state !== "running") return journal.outcome(previous, request);
      // No client drain is needed: clients use independent generations, never archive files.
      return await this.reserveLifecycle(() => journal.remove(this.snapshots, snapshotId, id));
    });
  }
  private async performSnapshotCreate(id: string): Promise<SnapshotRef> {
    const journal = this.snapshotJournal;
    const request = { kind: "create" as const };
    const previous = await journal.read(id);
    if (previous && previous.state !== "running") return journal.outcome(previous, request);
    const interruptedCreation = async (record: SnapshotOperation): Promise<never> => {
      // A process may die after publication but before its journal update. Inspect durable state
      // without requiring a live Timeline or resuming an uncertain source.
      try {
        const manifest = await this.snapshots.read(id, this.bake, this.config);
        await journal.update(record, { snapshot: manifest.snapshot });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      throw new Error(
        "Snapshot creation was interrupted; inspect the saved operation before using a new operation ID",
      );
    };
    if (previous) {
      return await this.reserveLifecycle(() => journal.run(id, request, interruptedCreation));
    }
    const wasAutomining = this.automine.enabled;
    let nativeChanged = false;
    let sourceReady = false;
    try {
      const saved = await this.lifecycleOperation(
        "snapshotCreate",
        () =>
          journal.run(id, request, async (record, interrupted) => {
            if (interrupted) return await interruptedCreation(record);
            await journal.update(record, {
              sourceGeneration: this.manifest.generation,
              automine: wasAutomining,
              stage: "checkpointing",
            });
            let resumeAttempted = false;
            try {
              await this.checkpointSession(() => {
                nativeChanged = true;
              });
              await journal.update(record, { stage: "copying" });
              const snapshot = await this.snapshots.capture(this.manifest.bake, id);
              await journal.update(record, { stage: "captured", snapshot });
              resumeAttempted = true;
              await this.resumeSession();
              sourceReady = true;
              await this.automine.set(wasAutomining);
              return snapshot;
            } catch (error) {
              // A rename may have succeeded before its caller lost acknowledgement. Preserve that
              // fact in the operation result without claiming that the source resumed successfully.
              if (!record.snapshot) {
                try {
                  const manifest = await this.snapshots.read(
                    id,
                    this.manifest.bake,
                    this.manifest.config,
                  );
                  await journal.update(record, { snapshot: manifest.snapshot });
                } catch (readback) {
                  if (!(readback instanceof Deno.errors.NotFound)) {
                    throw new AggregateError(
                      [error, readback],
                      "Snapshot creation/readback failed",
                    );
                  }
                }
              }
              if (
                !this.preserving && !resumeAttempted && this.network.generation?.phase === "stopped"
              ) {
                try {
                  await this.resumeSession();
                  sourceReady = true;
                  await this.automine.set(wasAutomining);
                } catch (resume) {
                  throw new AggregateError(
                    [error, resume],
                    "Snapshot creation and source recovery failed",
                  );
                }
              }
              throw error;
            }
          }),
        id,
      );
      this.ingress.resume();
      return saved;
    } catch (error) {
      if (
        !this.lifecyclePending &&
        (sourceReady || !nativeChanged && this.network.generation?.phase === "running")
      ) {
        try {
          this.time.assertHealthy();
          this.ingress.resume();
          await this.automine.set(wasAutomining);
        } catch { /* Uncertain drain or native progress must remain closed. */ }
      }
      throw error;
    }
  }
  async status(signal?: AbortSignal) {
    return {
      id: this.manifest.config.id,
      profile: this.manifest.config.profile,
      bake: this.manifest.config.bake,
      bakeKey: this.manifest.bake.key,
      now: this.time.timestamp,
      slot: this.time.slot,
      automine: this.automine.enabled,
      automineError: this.automine.error,
      el: await rpc(
        this.manifest.el,
        "eth_getBlockByNumber",
        ["latest", false],
        withWatchdog(signal),
      ),
      finality: await json(
        `${this.manifest.beacon}/eth/v1/beacon/states/head/finality_checkpoints`,
        { signal: withWatchdog(signal) },
      ),
    };
  }
  async command(method: string, args: unknown[] = []): Promise<unknown> {
    if (method === "lifecycle") return this.lifecycle();
    if (method === "snapshotOperation") {
      return await this.snapshotJournal.read(operationId(args[0]));
    }
    if (method === "snapshotList") return await this.snapshots.list();
    if (method === "snapshotCreate") return await this.createSnapshot(operationId(args[0]));
    if (method === "snapshotRestore") {
      return await this.restoreSnapshot(args[0] as string, operationId(args[1]));
    }
    if (method === "snapshotRemove") {
      return await this.removeSnapshot(args[0] as string, operationId(args[1]));
    }
    if (method === "stop") return await this.preserve();
    if (method === "resume") {
      await this.resume();
      return this.lifecycle();
    }
    const lease = this.ingress.enter();
    try {
      return await this.runCommand(method, args, lease.signal);
    } catch (error) {
      try {
        this.time.assertHealthy();
      } catch {
        this.ingress.fault(error);
      }
      throw error;
    } finally {
      lease.release();
    }
  }
  private async runCommand(method: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
    if (!Array.isArray(args)) throw new Error("Control params must be an array");
    switch (method) {
      case "status":
        return await this.status(signal);
      case "resources":
        return { cpu: cpuUsage(), memory: Deno.memoryUsage() };
      case "importValidator":
        return await this.time.exclusive(() =>
          importValidator(this.manifest, args[0], args[1], signal)
        );
      case "exitValidator":
        return await this.time.exclusive(() => exitValidator(this.manifest, args[0], signal));
      case "stepSlot":
        await this.time.stepSlot();
        break;
      case "advanceSlots":
        await this.time.advanceSlots(args[0] as number);
        break;
      case "advanceEpochs":
        await this.time.advanceEpochs(args[0] as number);
        break;
      case "advanceTime":
        await this.time.advanceTime(args[0] as number, { mode: warpMode(args[1]) });
        break;
      case "advanceTo":
        await this.time.advanceTo(args[0] as number, { mode: warpMode(args[1]) });
        break;
      case "skipSlots":
        await this.time.skipSlots(args[0] as number);
        break;
      case "setAutomine":
        if (typeof args[0] !== "boolean") throw new Error("setAutomine expects a boolean");
        await this.automine.set(args[0]);
        return null;
      default:
        throw new Error(`Unknown control method: ${method}`);
    }
    this.automine.notify();
    return { now: this.time.timestamp, slot: this.time.slot };
  }
  private async proxy(
    request: Request,
    target: "el" | "beacon" | "vc",
    path?: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const nativePath = decodeURIComponent(path ?? url.pathname).replace(/\/+$/, "");
    if (nativePath.startsWith("/lighthouse/panda/")) {
      return new Response("Native checkpoint endpoints are private", { status: 403 });
    }
    if (
      target === "vc" && this.checkpointCapable &&
      !["GET", "HEAD"].includes(request.method) &&
      ["/eth/v1/remotekeys", "/lighthouse/validators/web3signer"].includes(nativePath)
    ) {
      return new Response("Checkpoint-capable networks require disposable local validator keys", {
        status: 400,
      });
    }
    const lease = (request.headers.get("accept")?.includes("text/event-stream") ||
        url.pathname.includes("/events"))
      ? this.ingress.stream()
      : this.ingress.enter();
    try {
      const signal = AbortSignal.any([
        lease.signal,
        request.signal,
        this.serverAbort.signal,
        AbortSignal.timeout(defaultTimeoutMs()),
      ]);
      if (target === "el") {
        const body = await requestText(request, signal);
        const forward = () =>
          fetch(this.manifest.el, {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
            signal,
          });
        const response = this.running.admission
          ? await this.running.admission.forward(body, forward)
          : await forward();
        this.automine.notify();
        return this.ingress.holdResponse(response, lease);
      }
      const response = await fetch(`${this.manifest[target]}${path ?? url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        signal,
      });
      return this.ingress.holdResponse(response, lease);
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  serveClient(target: "beacon" | "vc", port = 0): string {
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port,
      signal: this.serverAbort.signal,
      onListen() {},
    }, async (request) => {
      const rejected = rejectForeignRequest(request);
      if (rejected) return rejected;
      try {
        return await this.proxy(request, target);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 503 });
      }
    });
    this.clientServers.push(server);
    return `http://127.0.0.1:${server.addr.port}`;
  }
  serve(port = 8545): string {
    this.server = Deno.serve({
      hostname: "127.0.0.1",
      port,
      signal: this.serverAbort.signal,
      onListen() {},
    }, async (request) => {
      const url = new URL(request.url);
      const rejected = rejectForeignRequest(request);
      if (rejected) return rejected;
      try {
        if (url.pathname === "/lifecycle") return Response.json(this.lifecycle());
        if (url.pathname === "/control" && request.method === "POST") {
          const command = JSON.parse(
            await requestText(
              request,
              AbortSignal.any([
                request.signal,
                this.serverAbort.signal,
                AbortSignal.timeout(defaultTimeoutMs()),
              ]),
            ),
          );
          if (command.method === "shutdown") {
            setTimeout(() => this.close().catch((error) => console.error(error)), 0);
            return Response.json({ id: this.config.id });
          }
          return Response.json({ result: await this.command(command.method, command.params) });
        }
        if (url.pathname.startsWith("/vc/")) {
          return await this.proxy(request, "vc", url.pathname.slice(3));
        }
        if (url.pathname.startsWith("/cl/")) {
          return await this.proxy(request, "beacon", url.pathname.slice(3));
        }
        if (url.pathname.startsWith("/eth/") || url.pathname.startsWith("/lighthouse/")) {
          return await this.proxy(request, "beacon");
        }
        if (url.pathname !== "/" || request.method !== "POST") {
          return new Response("Not found", { status: 404 });
        }
        return await this.proxy(request, "el");
      } catch (error) {
        return Response.json({ error: String(error) }, {
          status: this.ingress.status.ready ? 500 : 503,
        });
      }
    });
    return `http://127.0.0.1:${this.server.addr.port}`;
  }
  closePreserving(): Promise<void> {
    if (this.closing) return this.closing;
    return this.preserving ??= (async () => {
      try {
        // SIGTERM can arrive while an accepted SDK stop/resume is still persisting data.
        // Wait for its result before closing HTTP or letting the service stop dockerd.
        if (this.lifecycleWork) await this.lifecycleWork;
        if (!("manifest" in this.session)) {
          this.network.releaseRecovery();
          return;
        }
        if (this.network.generation?.phase !== "stopped" || !this.network.generation.checkpoint) {
          await this.preserveSession(true);
        }
      } finally {
        await this.closeServers();
      }
    })();
  }
  private async closeServers(): Promise<void> {
    this.serverAbort.abort(new Error("Panda server closed"));
    await Promise.all([this.server, ...this.clientServers].map((server) => server?.finished));
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (this.lifecycleWork) await this.lifecycleWork.catch(() => {});
      if ("time" in this.session) this.time.stop();
      try {
        await this.ingress.maintenance("destroy", async () => {
          if ("time" in this.session) {
            await this.automine.stop();
            await this.time.queue.idle();
          }
          await this.network.stop();
        });
      } finally {
        await this.closeServers();
      }
    })();
  }
}
