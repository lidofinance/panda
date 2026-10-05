import { Automine } from "./automine.ts";
import { Consensus } from "./consensus.ts";
import { type Config, configuration } from "./config.ts";
import { defaultTimeoutMs, json, rpc } from "./http.ts";
import { type Manifest, Network } from "./network.ts";
import { type Timeline, warpMode } from "./time.ts";
import { cpuUsage } from "node:process";
import { exitValidator, importValidator } from "./validators.ts";

export class Controller {
  readonly automine: Automine;
  server?: Deno.HttpServer<Deno.NetAddr>;
  private closing?: Promise<void>;
  constructor(readonly network: Network, readonly manifest: Manifest, readonly time: Timeline) {
    this.automine = new Automine(manifest.el, time);
  }
  static async start(input: Partial<Config> = {}): Promise<Controller> {
    const network = new Network(configuration(input));
    const manifest = await network.start();
    try {
      return new Controller(
        network,
        manifest,
        await Consensus.connect(manifest, network.engine, network),
      );
    } catch (error) {
      await network.stop();
      throw error;
    }
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
  serve(port = 8545): string {
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port, onListen: () => {} },
      async (request) => {
        const url = new URL(request.url);
        if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
          return new Response("Forbidden host", { status: 403 });
        }
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) {
          return new Response("Forbidden origin", { status: 403 });
        }
        const path = url.pathname;
        try {
          if (path === "/control" && request.method === "POST") {
            const command = await request.json();
            if (command.method === "shutdown") {
              // Let the response finish before shutting down this server.
              setTimeout(() => this.close().catch((error) => console.error(error)), 0);
              return Response.json({ id: this.manifest.config.id });
            }
            return Response.json({ result: await this.command(command.method, command.params) });
          }
          if (path.startsWith("/eth/") || path.startsWith("/lighthouse/")) {
            const url = new URL(request.url);
            if (this.network.consensusMessages) {
              return await this.network.consensusMessages.forward(request, this.manifest.beacon);
            }
            return await fetch(`${this.manifest.beacon}${url.pathname}${url.search}`, {
              method: request.method,
              headers: request.headers,
              body: request.method === "GET" || request.method === "HEAD"
                ? undefined
                : request.body,
              signal: AbortSignal.timeout(defaultTimeoutMs()),
            });
          }
          if (path !== "/" || request.method !== "POST") {
            return new Response("Not found", {
              status: 404,
            });
          }
          const body = await request.text();
          const upstream = await fetch(this.manifest.el, {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(defaultTimeoutMs()),
          });
          const response = await upstream.text();
          // Preserve upstream batch ordering, IDs, errors and notification responses verbatim.
          let shouldWake = false;
          try {
            const parsed = JSON.parse(body);
            const calls = Array.isArray(parsed) ? parsed : [parsed];
            shouldWake = calls.some((call) =>
              call?.method === "eth_sendRawTransaction" || call?.method === "eth_sendTransaction"
            );
          } catch { /* Geth owns JSON-RPC validation. */ }
          if (shouldWake) this.automine.notify();
          return new Response(response || null, {
            status: upstream.status,
            headers: { "content-type": "application/json" },
          });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      },
    );
    return `http://127.0.0.1:${this.server.addr.port}`;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.time.stop();
      try {
        await this.server?.shutdown();
        await this.automine.stop();
        await this.time.queue.idle();
      } finally {
        await this.network.stop();
      }
    })();
  }
}
