import { Automine } from "./automine.ts";
import { Consensus } from "./consensus.ts";
import { type Config, configuration } from "./config.ts";
import { deadline, defaultTimeoutMs, json, rpc, waitFor, withWatchdog } from "./http.ts";
import { AdmissionLedger } from "./admission.ts";
import { Ingress } from "./ingress.ts";
import { type Checkpoint, durableJson } from "./storage.ts";
import { type Manifest, Network } from "./network.ts";
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

interface LifecycleOperation {
  id: string;
  name: string;
  state: "running" | "succeeded" | "failed";
  result?: unknown;
  error?: string;
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
  private session: Session;
  private operation?: LifecycleOperation;
  constructor(network: Network, manifest: Manifest, time: Timeline, admission?: AdmissionLedger) {
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
    return this.session.manifest;
  }
  get time() {
    return this.session.time;
  }
  get automine() {
    return this.session.automine;
  }
  private get checkpointCapable(): boolean {
    return this.manifest.config.mode === "controlled" &&
      this.manifest.bake?.recipe.checkpointAbi === 1;
  }

  private static async open(
    network: Network,
    mode: "new" | "resume" | "auto",
    signal?: AbortSignal,
  ): Promise<Session> {
    const manifest = await network.start(mode, signal);
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
      return {
        id: crypto.randomUUID(),
        network,
        manifest,
        time,
        admission,
        automine: new Automine(manifest.el, time),
      };
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
    const session = await Controller.open(new Network(configuration(input)), mode, signal);
    const controller = new Controller(session.network, session.manifest, session.time);
    controller.session = session;
    return controller;
  }
  lifecycle() {
    return {
      ...this.ingress.status,
      id: this.manifest.config.id,
      profile: this.manifest.config.profile,
      bake: this.manifest.config.bake,
      generation: this.manifest.generation,
      sessionId: this.session.id,
      now: this.time.timestamp,
      slot: this.time.slot,
      operation: this.operation,
      checkpointCapable: this.checkpointCapable,
    };
  }
  private lifecycleOperation<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (this.lifecyclePending) {
      return Promise.reject(new Error("Another lifecycle operation is in progress"));
    }
    this.lifecyclePending = true;
    const work = this.performLifecycleOperation(name, run);
    this.lifecycleWork = work;
    const finished = () => {
      if (this.lifecycleWork === work) this.lifecycleWork = undefined;
    };
    void work.then(finished, finished);
    return work;
  }
  private async performLifecycleOperation<T>(name: string, run: () => Promise<T>): Promise<T> {
    const operation: LifecycleOperation = { id: crypto.randomUUID(), name, state: "running" };
    this.operation = operation;
    try {
      return await this.ingress.maintenance(name, async () => {
        await durableJson(`${this.network.store.root}/operation.json`, operation);
        const result = await run();
        operation.state = "succeeded";
        operation.result = result ?? null;
        await durableJson(`${this.network.store.root}/operation.json`, operation);
        return result;
      });
    } catch (error) {
      // Drain can fail before the callback runs. Its failure must be visible too.
      this.operation = { ...operation, state: "failed", error: String(error) };
      await durableJson(`${this.network.store.root}/operation.json`, this.operation);
      throw error;
    } finally {
      this.lifecyclePending = false;
    }
  }
  async preserve(): Promise<Checkpoint> {
    // Reject unsupported artifacts before closing ingress or changing protocol/client state.
    if (!this.checkpointCapable) {
      throw new Error("Session has no controlled checkpoint capability");
    }
    const wasAutomining = this.automine.enabled;
    let nativeChanged = false;
    try {
      return await this.lifecycleOperation("stop", async () => {
        const { network, manifest, time, automine, admission } = this.session;
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
        nativeChanged = true;
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
      });
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
    if (this.ingress.status.ready) throw new Error("Network is already running");
    await this.lifecycleOperation("resume", async () => {
      const next = await Controller.open(new Network(this.manifest.config), "resume");
      this.session = next;
      this.watchTimeline();
      return { sessionId: next.id, generation: next.manifest.generation, nowMs: next.time.nowMs };
    });
    this.ingress.resume();
  }
  async status() {
    return {
      id: this.manifest.config.id,
      profile: this.manifest.config.profile,
      bake: this.manifest.config.bake,
      bakeKey: this.manifest.bake.key,
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
  async command(method: string, args: unknown[] = []): Promise<unknown> {
    if (method === "lifecycle") return this.lifecycle();
    if (method === "stop") return await this.preserve();
    if (method === "resume") {
      await this.resume();
      return this.lifecycle();
    }
    const lease = this.ingress.enter();
    try {
      return await this.runCommand(method, args);
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
  private async runCommand(method: string, args: unknown[]): Promise<unknown> {
    if (!Array.isArray(args)) throw new Error("Control params must be an array");
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
        const response = this.session.admission
          ? await this.session.admission.forward(body, forward)
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
            return Response.json({ id: this.manifest.config.id });
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
    return this.preserving ??= (async () => {
      try {
        // SIGTERM can arrive while an accepted SDK stop/resume is still persisting data.
        // Wait for its result before closing HTTP or letting the service stop dockerd.
        if (this.lifecycleWork) await this.lifecycleWork;
        if (this.network.generation?.phase !== "stopped" || !this.network.generation.checkpoint) {
          await this.preserve();
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
      this.time.stop();
      try {
        await this.ingress.maintenance("destroy", async () => {
          await this.automine.stop();
          await this.time.queue.idle();
          await this.network.stop();
        });
      } finally {
        await this.closeServers();
      }
    })();
  }
}
