import { Automine } from "./automine.ts";
import { Consensus } from "./consensus.ts";
import { type Config, configuration } from "./config.ts";
import { defaultTimeoutMs, json, rpc } from "./http.ts";
import { type Manifest, Network, snapshotCapable } from "./network.ts";
import { type Timeline, warpMode } from "./time.ts";
import { cpuUsage } from "node:process";
import { exitValidator, importValidator } from "./validators.ts";
import { Ingress } from "./ingress.ts";
import { SnapshotStore } from "./snapshots.ts";
import { operationId, SnapshotJournal, SnapshotOperationError } from "./snapshot_operations.ts";
import type {
  SnapshotCommands,
  SnapshotControlError,
  SnapshotLifecycle,
  SnapshotRef,
  SnapshotRequest,
  SnapshotRestoreResult,
} from "./snapshot_types.ts";
import { captureSavedState, readOnlyBeaconPost, snapshotRequestSupported } from "./saved_state.ts";
import { ConsensusAdmissionError } from "./consensus_messages.ts";
import { type Bake, canonical, readBake } from "./profiles.ts";
import { StateLock, StateStore } from "./storage.ts";
import type { SnapshotImportOptions } from "./snapshot_archive.ts";

/** Mirrors main's automine wake rule; malformed JSON is rejected by Geth without effect. */
function submitsTransaction(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).some((call) =>
      ["eth_sendRawTransaction", "eth_sendRawTransactionSync", "eth_sendTransaction"]
        .includes(call?.method)
    );
  } catch {
    return false;
  }
}

/** Buffer a request body, but let drain cancellation release a stalled upload. */
async function readText(request: Request, signal: AbortSignal): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const cancel = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

interface Session {
  network: Network;
  manifest: Manifest;
  time: Timeline;
  automine: Automine;
}

export class Controller {
  readonly ingress = new Ingress();
  server?: Deno.HttpServer<Deno.NetAddr>;
  private readonly clientServers: Deno.HttpServer<Deno.NetAddr>[] = [];
  private closing?: Promise<void>;
  private preservingClose = false;
  private destroyRequested = false;
  private stopping = false;
  private owner?: StateLock;
  private lifecycleWork?: Promise<unknown>;
  private sessionId = crypto.randomUUID();
  private session?: Session;
  private readonly jobs = new Map<string, { request: SnapshotRequest; work: Promise<unknown> }>();
  private recoveryNetwork: Network;
  private readonly bake: Bake;
  private cleanup?: { state: "succeeded" | "failed"; error?: string };
  constructor(network: Network, manifest: Manifest | Bake, time?: Timeline) {
    this.recoveryNetwork = network;
    if ("recipe" in manifest) {
      this.bake = manifest;
      this.ingress.fault(new Error("Explicit snapshot restoration required"));
    } else {
      if (!time) throw new Error("Running session requires a timeline");
      this.bake = manifest.bake;
      this.session = { network, manifest, time, automine: new Automine(manifest.el, time) };
    }
  }
  get network(): Network {
    return this.session?.network ?? this.recoveryNetwork;
  }
  private get running(): Session {
    if (!this.session) throw new Error("Explicit snapshot restoration required");
    return this.session;
  }
  get manifest(): Manifest {
    return this.running.manifest;
  }
  get time(): Timeline {
    return this.running.time;
  }
  get automine(): Automine {
    return this.running.automine;
  }
  private get config(): Config {
    return this.network.config;
  }
  private get snapshots(): SnapshotStore {
    return new SnapshotStore(this.network.store, this.network.infra);
  }
  private get journal(): SnapshotJournal {
    return new SnapshotJournal(this.network.store);
  }

  private static async open(network: Network, mode: "new" | "resume" | "auto"): Promise<Session> {
    const manifest = await network.start(mode);
    try {
      const time = await Consensus.connect(manifest, network.engine, network);
      return { network, manifest, time, automine: new Automine(manifest.el, time) };
    } catch (error) {
      await network.abandonStart(error);
      throw error;
    }
  }
  /** One live controller per id; its startup also collects transfers killed with an owner. */
  private static async own(network: Network): Promise<StateLock> {
    await network.store.initialize();
    const owner = await StateLock.acquire(`${network.store.root}/controller.owner`);
    try {
      await new SnapshotStore(network.store, network.infra).sweepTransfers();
      return owner;
    } catch (error) {
      owner.release();
      throw error;
    }
  }
  static async start(
    input: Partial<Config> = {},
    mode: "new" | "resume" | "auto" = "new",
  ): Promise<Controller> {
    const network = new Network(configuration(input));
    const owner = await this.own(network);
    try {
      const session = await this.open(network, mode);
      const controller = new Controller(session.network, session.manifest, session.time);
      controller.owner = owner;
      return controller;
    } catch (error) {
      owner.release();
      throw error;
    }
  }
  static async recover(input: Partial<Config> = {}): Promise<Controller> {
    const network = new Network(configuration(input));
    const owner = await this.own(network);
    try {
      const controller = new Controller(network, await network.enterRecovery());
      controller.owner = owner;
      return controller;
    } catch (error) {
      owner.release();
      throw error;
    }
  }
  /** Retained state always wins over defaults and seeds; unclean state needs explicit recovery. */
  static async launch(
    input: Partial<Config>,
    seed?: { source: string; sha256?: string },
  ): Promise<Controller> {
    const retained = await new StateStore(configuration(input).id).active();
    if (!retained) {
      return seed
        ? await this.fromSnapshot(seed.source, input, { sha256: seed.sha256 })
        : await this.start(input, "auto");
    }
    for (const key of ["profile", "bake"] as const) {
      if (input[key] !== undefined && input[key] !== retained.config[key]) {
        throw new Error(
          "Explicit profile/bake differs from retained network; use down/reset or another PANDA_ID",
        );
      }
    }
    if (retained.phase === "stopped") return await this.start(retained.config, "resume");
    if (!await new StateStore(retained.config.id).ownerReleased()) {
      throw new Error("Devnet is owned by live process; use its controller");
    }
    if (
      !snapshotCapable(
        retained.config,
        await readBake(retained.config.profile, retained.config.bake),
      )
    ) {
      throw new Error(
        `Network ${retained.config.id} was not stopped cleanly; use down/reset or another PANDA_ID`,
      );
    }
    return await this.recover(retained.config);
  }
  static async fromSnapshot(
    source: string,
    input: Partial<Config> = {},
    options: SnapshotImportOptions = {},
  ): Promise<Controller> {
    const config = configuration(input);
    const store = new StateStore(config.id);
    const owner = await this.own(new Network(config));
    let controller: Controller | undefined;
    let recovery: Network | undefined;
    try {
      const active = await store.active();
      if (active) {
        for (const key of Object.keys(input) as (keyof Config)[]) {
          if (input[key] !== undefined && input[key] !== active.config[key]) {
            throw new Error(`Retained network configuration mismatch: ${key}`);
          }
        }
        const session = await this.open(new Network(active.config), "resume");
        controller = new Controller(session.network, session.manifest, session.time);
      } else {
        const network = new Network(config);
        const snapshots = new SnapshotStore(store, network.infra);
        const ref = await snapshots.import(source, options);
        const saved = await snapshots.read(ref.id);
        for (const key of Object.keys(input) as (keyof Config)[]) {
          if (key !== "id" && input[key] !== undefined && input[key] !== saved.config[key]) {
            throw new Error(`Snapshot configuration mismatch: ${key}`);
          }
        }
        recovery = new Network(saved.config);
        controller = new Controller(recovery, await recovery.enterRecovery());
        await controller.restoreSnapshot(ref.id, crypto.randomUUID());
      }
      controller.owner = owner;
      return controller;
    } catch (error) {
      recovery?.releaseRecovery();
      owner.release();
      throw error;
    }
  }

  lifecycle(): SnapshotLifecycle {
    let healthy = this.ingress.status.ready && !this.stopping;
    try {
      this.session?.time.assertHealthy();
    } catch {
      healthy = false;
    }
    return {
      ...this.ingress.status,
      ready: healthy,
      id: this.config.id,
      profile: this.config.profile,
      bake: this.config.bake,
      generation: this.network.generation?.generation,
      sessionId: this.sessionId,
      now: this.session?.time.timestamp,
      slot: this.session?.time.slot,
      recoveryRequired: !healthy,
      cleanup: this.cleanup,
    };
  }
  async status() {
    return {
      id: this.manifest.config.id,
      profile: this.manifest.config.profile,
      bake: this.manifest.config.bake,
      bakeKey: this.manifest.bake.key,
      sessionId: this.sessionId,
      now: this.time.timestamp,
      slot: this.time.slot,
      automine: this.automine.enabled,
      automineError: this.automine.error,
      el: await rpc(this.manifest.el, "eth_getBlockByNumber", ["latest", false]),
      finality: await json(
        `${this.manifest.beacon}/eth/v1/beacon/states/head/finality_checkpoints`,
      ),
    };
  }
  private reserve<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing || this.stopping) return Promise.reject(new Error("Controller is stopping"));
    if (this.lifecycleWork) {
      return Promise.reject(new Error("Lifecycle operation already in progress"));
    }
    const work = Promise.resolve().then(run);
    this.lifecycleWork = work;
    const done = () => {
      if (this.lifecycleWork === work) this.lifecycleWork = undefined;
    };
    void work.then(done, done);
    return work;
  }
  private async maintenance<T>(name: string, work: () => Promise<T>): Promise<T> {
    return await this.ingress.maintenance(name, work, defaultTimeoutMs(), async () => {
      await this.session?.automine.set(false);
      await this.session?.time.queue.idle();
    });
  }
  private job<T>(id: string, request: SnapshotRequest, run: () => Promise<T>): Promise<T> {
    operationId(id);
    const pending = this.jobs.get(id);
    if (pending) {
      if (canonical(pending.request) !== canonical(request)) {
        throw new Error("Operation ID request conflict");
      }
      return pending.work as Promise<T>;
    }
    const work = this.reserve(run);
    this.jobs.set(id, { request, work });
    const done = () => this.jobs.delete(id);
    void work.then(done, done);
    return work;
  }
  private adopt(session: Session): void {
    this.session = session;
    this.recoveryNetwork = session.network;
    this.sessionId = crypto.randomUUID();
  }
  createSnapshot(id: string = crypto.randomUUID()): Promise<SnapshotRef> {
    return this.job(id, { kind: "create" }, async () => {
      await this.network.store.initialize();
      return await this.journal.run(id, { kind: "create" }, async (record, interrupted) => {
        if (interrupted) {
          try {
            record.snapshot = (await this.snapshots.read(id, this.bake, this.config)).snapshot;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          await this.journal.update(record, {});
          throw new Error(
            "Creation interrupted; inspect the operation and restore its published snapshot explicitly",
          );
        }
        if (!this.ingress.status.ready) {
          throw new Error(
            `Cannot capture while ingress is ${this.ingress.status.phase}; explicit recovery required`,
          );
        }
        const wasAutomining = this.automine.enabled;
        let changed = false;
        let resumed = false;
        let resumeAttempted = false;
        try {
          const result = await this.maintenance("snapshotCreate", async () => {
            this.time.assertHealthy();
            const saved = await captureSavedState(
              this.manifest,
              this.time.nowMs,
              this.network.consensusMessages!,
            );
            await this.journal.update(record, {
              stage: "stopping",
              automine: wasAutomining,
              sourceGeneration: this.network.generation?.generation,
            });
            changed = true;
            await this.network.preserve(saved);
            this.time.stop();
            try {
              await this.journal.update(record, { stage: "copying" });
              const snapshot = await this.snapshots.capture(this.bake, id, async (value) => {
                await this.journal.update(record, { candidateGeneration: value.generation });
              });
              await this.journal.update(record, { stage: "captured", snapshot });
              resumeAttempted = true;
              this.adopt(await Controller.open(new Network(this.config), "resume"));
              resumed = true;
              return snapshot;
            } catch (error) {
              // Publication may have succeeded even if its acknowledgement failed.
              if (!record.snapshot) {
                try {
                  record.snapshot =
                    (await this.snapshots.read(id, this.bake, this.config)).snapshot;
                } catch (readback) {
                  if (!(readback instanceof Deno.errors.NotFound)) throw readback;
                }
                await this.journal.update(record, {});
              }
              if (!resumeAttempted && this.network.generation?.phase === "stopped") {
                resumeAttempted = true;
                try {
                  this.adopt(await Controller.open(new Network(this.config), "resume"));
                  resumed = true;
                } catch (resume) {
                  throw new AggregateError(
                    [error, resume],
                    "Snapshot copy and source resume failed",
                  );
                }
              }
              throw error;
            }
          });
          this.ingress.resume();
          await this.automine.set(wasAutomining);
          return result;
        } catch (error) {
          if (!changed || resumed) await this.reopen(wasAutomining);
          throw error;
        } finally {
          await this.cleanupSnapshots(record);
        }
      });
    });
  }
  restoreSnapshot(
    snapshotId: string,
    id: string = crypto.randomUUID(),
  ): Promise<SnapshotRestoreResult> {
    operationId(snapshotId);
    return this.job(id, { kind: "restore", snapshotId }, async () => {
      await this.network.store.initialize();
      return await this.journal.run(
        id,
        { kind: "restore", snapshotId },
        async (record, interrupted) => {
          if (interrupted) {
            throw new Error(
              "Restoration interrupted; use a new operation ID for explicit recovery",
            );
          }
          const wasAutomining = this.session?.automine.enabled ?? false;
          let changed = false;
          try {
            const source = this.network;
            // Integrity, compatibility and the full data copy precede any source mutation.
            const snapshot =
              (await this.snapshots.read(snapshotId, this.bake, this.config)).snapshot;
            const candidate = await this.snapshots.prepare(
              snapshotId,
              this.bake,
              this.config,
              async (value) => {
                await this.journal.update(record, {
                  stage: "preparing",
                  snapshot,
                  sourceGeneration: source.generation?.generation,
                  candidateGeneration: value.generation,
                });
              },
            );
            const result = await this.maintenance("snapshotRestore", async () => {
              await this.journal.update(record, { stage: "source-stopping" });
              changed = true;
              this.session?.time.stop();
              await source.discard();
              await this.journal.update(record, { stage: "source-stopped" });
              const next = new Network(this.config);
              this.recoveryNetwork = next;
              this.session = undefined;
              try {
                const manifest = await next.startCandidate(candidate);
                await this.journal.update(record, { stage: "candidate-verified" });
                await next.commitCandidate();
                await this.journal.update(record, { stage: "committed" });
                await next.activateValidator();
                const time = await Consensus.connect(manifest, next.engine, next);
                this.adopt({
                  network: next,
                  manifest,
                  time,
                  automine: new Automine(manifest.el, time),
                });
                return {
                  snapshot,
                  generation: candidate.generation,
                  sessionId: this.sessionId,
                  nowMs: time.nowMs,
                };
              } catch (error) {
                await next.fail(error);
                throw error;
              }
            });
            this.ingress.resume();
            await this.journal.update(record, { stage: "published", result });
            return result;
          } catch (error) {
            if (!changed && this.session) await this.reopen(wasAutomining);
            throw error;
          } finally {
            await this.cleanupSnapshots(record);
          }
        },
      );
    });
  }
  /** Reopen an untouched source; an uncertain drain or unhealthy timeline stays closed. */
  private async reopen(automine: boolean): Promise<void> {
    if (this.ingress.status.ready) return; // Maintenance never began.
    try {
      this.time.assertHealthy();
      this.ingress.resume();
      // During shutdown the source is preserved next; do not re-arm block production.
      if (!this.stopping) await this.automine.set(automine);
    } catch (error) {
      console.error(JSON.stringify({ event: "ingress-reopen-refused", error: String(error) }));
    }
  }
  private async cleanupSnapshots(
    record: import("./snapshot_types.ts").SnapshotOperationRecord,
  ): Promise<void> {
    try {
      await this.network.cleanupSnapshotData(await this.journal.list());
      this.cleanup = { state: "succeeded" };
    } catch (error) {
      this.cleanup = { state: "failed", error: String(error) };
    }
    try {
      await this.journal.update(record, { cleanup: this.cleanup });
    } catch (error) {
      this.cleanup = { state: "failed", error: `Cleanup outcome could not be recorded: ${error}` };
      record.cleanup = this.cleanup;
      console.error(JSON.stringify({ event: "snapshot-cleanup-failed", ...this.cleanup }));
    }
  }
  removeSnapshot(snapshotId: string, id: string = crypto.randomUUID()): Promise<SnapshotRef> {
    operationId(snapshotId);
    return this.job(
      id,
      { kind: "remove", snapshotId },
      () => this.journal.remove(this.snapshots, snapshotId, id),
    );
  }
  async preserve(): Promise<void> {
    return await this.reserve(() => this.preserveSession());
  }
  private async preserveSession(): Promise<void> {
    if (this.ingress.status.phase === "parked") return;
    if (!this.ingress.status.ready) {
      throw new Error("Cannot preserve faulted ingress; restore explicitly");
    }
    const wasAutomining = this.automine.enabled;
    let changed = false;
    try {
      await this.maintenance("stop", async () => {
        this.time.assertHealthy();
        const saved = await captureSavedState(
          this.manifest,
          this.time.nowMs,
          this.network.consensusMessages!,
        );
        changed = true;
        await this.network.preserve(saved);
        this.time.stop();
      });
    } catch (error) {
      if (!changed) await this.reopen(wasAutomining);
      throw error;
    }
  }
  async resume(): Promise<void> {
    return await this.reserve(async () => {
      await this.maintenance("resume", async () => {
        if (this.network.generation?.phase !== "stopped") {
          throw new Error("No cleanly stopped network");
        }
        this.adopt(await Controller.open(new Network(this.config), "resume"));
      });
      this.ingress.resume();
    });
  }
  async command(method: string, args: unknown[] = []): Promise<unknown> {
    if (!Array.isArray(args)) throw new Error("Control params must be an array");
    switch (method) {
      case "lifecycle":
        return this.lifecycle() satisfies SnapshotCommands[typeof method]["result"];
      case "snapshotList":
        await this.network.store.initialize();
        return await this.snapshots.list() satisfies SnapshotCommands[typeof method]["result"];
      case "snapshotOperation":
        return await this.journal.read(
          operationId(args[0]),
        ) satisfies SnapshotCommands[typeof method]["result"];
      case "snapshotCreate":
        return await this.createSnapshot(
          args[0] as string | undefined,
        ) satisfies SnapshotCommands[typeof method]["result"];
      case "snapshotRestore":
        return await this.restoreSnapshot(
          args[0] as string,
          args[1] as string | undefined,
        ) satisfies SnapshotCommands[typeof method]["result"];
      case "snapshotRemove":
        return await this.removeSnapshot(
          args[0] as string,
          args[1] as string | undefined,
        ) satisfies SnapshotCommands[typeof method]["result"];
      case "stop":
        await this.preserve();
        return this.lifecycle() satisfies SnapshotCommands[typeof method]["result"];
      case "resume":
        await this.resume();
        return this.lifecycle() satisfies SnapshotCommands[typeof method]["result"];
    }
    if (this.stopping) throw new Error("Controller is stopping");
    const lease = this.ingress.enter();
    try {
      // A faulted timeline rejects every mutation itself; reads remain available for diagnosis.
      if (method !== "status" && method !== "resources") this.time.assertHealthy();
      return await this.runCommand(method, args);
    } finally {
      lease.release();
    }
  }
  private async runCommand(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "status":
        return await this.status();
      case "resources":
        return { cpu: cpuUsage(), memory: Deno.memoryUsage() };
      case "importValidator":
        return await this.time.exclusive(() => importValidator(this.manifest, args[0], args[1]));
      case "exitValidator":
        return await this.time.exclusive(() => exitValidator(this.manifest, args[0]));
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
    pathname?: string,
  ): Promise<Response> {
    if (this.stopping) throw new Error("Controller is stopping");
    const url = new URL(request.url);
    const stream = (pathname ?? url.pathname) === "/eth/v1/events";
    const lease = stream ? this.ingress.stream() : this.ingress.enter();
    const path = pathname ?? url.pathname;
    // JSON-RPC and some Beacon queries use POST too; nothing is a write before it is forwarded.
    let write = target !== "el" && request.method !== "GET" && request.method !== "HEAD" &&
      !readOnlyBeaconPost(path);
    try {
      const body = target === "el"
        ? await readText(
          request,
          AbortSignal.any([request.signal, lease.signal, AbortSignal.timeout(defaultTimeoutMs())]),
        )
        : undefined;
      if (body !== undefined) write = submitsTransaction(body);
      if (write) this.time.assertHealthy();
      // A write is not abandoned with its client: its native outcome must be known before drain.
      const signal = AbortSignal.any([
        ...(write ? [] : [request.signal]),
        lease.signal,
        AbortSignal.timeout(defaultTimeoutMs()),
      ]);
      if (!snapshotRequestSupported(target, request.method, path)) {
        this.network.consensusMessages?.refuseSnapshot(
          `Untracked ${
            target === "beacon" ? "Beacon" : "validator"
          } mutation ${request.method} ${path}; restore a completed snapshot or start a fresh network before saving`,
        );
      }
      const upstream = this.manifest[target] + path + url.search;
      const forwarded = body === undefined
        ? new Request(new Request(upstream, request), { signal })
        : new Request(upstream, { method: request.method, headers: request.headers, body, signal });
      const response = target === "beacon" && this.network.consensusMessages
        ? await this.network.consensusMessages.forward(forwarded, this.manifest.beacon)
        : await fetch(forwarded);
      if (target === "el" && write) this.automine.notify();
      // Response headers prove the native outcome; a lost body afterwards cannot change it.
      return this.ingress.holdResponse(response, lease);
    } catch (error) {
      lease.release();
      if (error instanceof ConsensusAdmissionError) {
        return Response.json({ code: error.status, message: error.message }, {
          status: error.status,
        });
      }
      if (write) {
        this.network.consensusMessages?.refuseSnapshot(
          `Submission outcome is uncertain: ${error}; restore a completed snapshot or start a fresh network before saving`,
        );
      }
      throw error;
    }
  }
  serveClient(target: "beacon" | "vc", port = 0): string {
    const server = Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, async (request) => {
      const rejected = this.rejectForeign(request);
      if (rejected) return rejected;
      try {
        return await this.proxy(request, target);
      } catch (error) {
        return this.failure(error);
      }
    });
    this.clientServers.push(server);
    return `http://127.0.0.1:${server.addr.port}`;
  }
  private rejectForeign(request: Request): Response | undefined {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      return new Response("Forbidden host", { status: 403 });
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return new Response("Forbidden origin", { status: 403 });
  }
  private failure(error: unknown): Response {
    return Response.json(
      {
        error: String(error),
        ...(error instanceof SnapshotOperationError ? { operation: error.operation } : {}),
      } satisfies SnapshotControlError,
      { status: this.ingress.status.ready ? 500 : 503 },
    );
  }
  serve(port = 8545): string {
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port, onListen() {} },
      async (request, info) => {
        const url = new URL(request.url);
        const rejected = this.rejectForeign(request);
        if (rejected) return rejected;
        try {
          if (url.pathname === "/lifecycle" && request.method === "GET") {
            return Response.json(
              this.lifecycle(),
            );
          }
          const archive = /^\/snapshots\/([a-f0-9-]+)\/archive$/.exec(url.pathname);
          if (archive && request.method === "GET") {
            const exported = await this.reserve(() => this.snapshots.export(archive[1]));
            void info.completed.then(exported.cleanup, exported.cleanup).catch(console.error);
            const file = await Deno.open(exported.path, { read: true });
            return new Response(file.readable, {
              headers: {
                "content-type": "application/gzip",
                "content-length": String(exported.bytes),
                "x-panda-sha256": exported.sha256,
              },
            });
          }
          if (url.pathname === "/control" && request.method === "POST") {
            const command = await request.json();
            if (command.method === "shutdown") {
              setTimeout(() => this.close().catch(console.error), 0);
              return Response.json({ id: this.config.id });
            }
            return Response.json({ result: await this.command(command.method, command.params) });
          }
          if (url.pathname.startsWith("/vc/")) {
            return await this.proxy(
              request,
              "vc",
              url.pathname.slice(3),
            );
          }
          if (url.pathname.startsWith("/cl/")) {
            return await this.proxy(
              request,
              "beacon",
              url.pathname.slice(3),
            );
          }
          if (
            url.pathname.startsWith("/eth/") || url.pathname.startsWith("/lighthouse/")
          ) return await this.proxy(request, "beacon");
          if (url.pathname === "/" && request.method === "POST") {
            return await this.proxy(
              request,
              "el",
            );
          }
          return new Response("Not found", { status: 404 });
        } catch (error) {
          return this.failure(error);
        }
      },
    );
    return `http://127.0.0.1:${this.server.addr.port}`;
  }
  private async closeServers(): Promise<void> {
    this.ingress.cancelPending(new Error("Controller shutdown"));
    await Promise.all([
      this.server?.shutdown(),
      ...this.clientServers.map((server) => server.shutdown()),
    ]);
  }
  closePreserving(): Promise<void> {
    if (this.closing) return this.closing;
    if (!snapshotCapable(this.config, this.bake)) return this.close();
    this.stopping = true;
    this.preservingClose = true;
    return this.closing = (async () => {
      await this.lifecycleWork?.catch(() => {});
      try {
        if (this.session) await this.preserveSession();
        else await this.network.fail(new Error("Recovery controller stopped"), "network");
      } catch (error) {
        if (this.session) await this.network.fail(error);
        throw error;
      } finally {
        try {
          await this.closeServers();
        } finally {
          try {
            // A `down` that arrived during preservation still owns removal of the network.
            if (this.destroyRequested) await this.destroyNetwork();
          } finally {
            this.owner?.release();
          }
        }
      }
    })();
  }
  close(): Promise<void> {
    if (this.closing) {
      if (this.preservingClose) this.destroyRequested = true;
      return this.closing;
    }
    this.stopping = true;
    return this.closing = (async () => {
      await this.lifecycleWork?.catch(() => {});
      this.session?.time.stop();
      try {
        await this.closeServers();
        await this.session?.automine.stop();
        await this.session?.time.queue.idle();
      } finally {
        try {
          await this.destroyNetwork();
        } finally {
          this.owner?.release();
        }
      }
    })();
  }
  private async destroyNetwork(): Promise<void> {
    const restoring = this.network.restoring;
    await this.network.stop();
    // An abandoned candidate stops only its own clients; the active generation remains.
    if (restoring || this.network.restoring) await new Network(this.config).stop();
  }
}
