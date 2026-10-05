import { Writable } from "node:stream";
// @deno-types="@types/dockerode"
import type Docker from "dockerode";
import { deadline, defaultTimeoutMs, withWatchdog } from "./http.ts";
import { type Infrastructure } from "./docker.ts";

export async function checkEngineCapabilities(
  url: string,
  secret: string,
  required: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const bytes = Uint8Array.from(
    secret.trim().replace(/^0x/, "").match(/../g)!.map((x) => parseInt(x, 16)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const base64 = (data: Uint8Array) =>
    btoa(String.fromCharCode(...data)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const encode = (value: unknown) => base64(new TextEncoder().encode(JSON.stringify(value)));
  const message = `${encode({ alg: "HS256", typ: "JWT" })}.${
    encode({ iat: Math.floor(Date.now() / 1000) })
  }`;
  const signature = base64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${message}.${signature}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "engine_exchangeCapabilities",
      params: [required],
    }),
    signal: withWatchdog(signal),
  });
  const data = await response.json();
  if (
    !response.ok || !Array.isArray(data.result) ||
    required.some((method) => !data.result.includes(method))
  ) {
    throw new Error(`EL does not support this bake's Engine methods: ${required.join(", ")}`);
  }
  return data.result;
}

/** Geth v1.15.11 has no Engine API readiness event. Its structured Updated payload
 * log is emitted after the full payload is installed under the payload lock.
 * This adapter is deliberately version-specific; it never changes payload contents. */
export class EngineGate {
  private readonly ready = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private stream?: import("node:stream").Readable;
  private server?: Deno.HttpServer<Deno.NetAddr>;
  private jwtKey!: CryptoKey;
  private closed = false;
  private logError?: unknown;
  url = "";
  constructor(readonly upstream: string, public nowMs: number) {}

  static async start(
    infra: Infrastructure,
    container: Docker.Container,
    upstream: string,
    nowMs: number,
    jwt: string,
    signal?: AbortSignal,
  ): Promise<EngineGate> {
    signal?.throwIfAborted();
    const gate = new EngineGate(upstream, nowMs);
    const bytes = Uint8Array.from(
      jwt.trim().replace(/^0x/, "").match(/../g)!.map((part) => parseInt(part, 16)),
    );
    gate.jwtKey = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    signal?.throwIfAborted();
    // The service's later SIGTERM must not close this stream before checkpoint drain.
    // Cancellation and its watchdog cover only opening the subscription.
    const opening = new AbortController();
    const cancel = () => opening.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => opening.abort(new Error("Timed out: Geth log subscription")),
      defaultTimeoutMs(),
    );
    try {
      gate.stream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 0,
        abortSignal: opening.signal,
      }) as import("node:stream").Readable;
      signal?.throwIfAborted();
      opening.signal.throwIfAborted();
    } catch (error) {
      gate.stream?.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    let buffer = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const entry = JSON.parse(line);
            if (entry.msg === "Updated payload" && typeof entry.id === "string") {
              gate.payloadReady(entry.id);
            }
          } catch { /* Startup output need not be JSON; readiness messages must be. */ }
        }
        callback();
      },
    });
    infra.docker.modem.demuxStream(gate.stream, output, output);
    gate.stream.on("error", (error) => {
      gate.logError = error;
    });
    gate.stream.on("end", () => {
      gate.logError = new Error("Geth log stream ended");
    });
    try {
      // Linux containers reach the host-gateway address. JWT is verified here and again by Geth.
      gate.server = Deno.serve(
        { hostname: "0.0.0.0", port: 0, onListen: () => {} },
        (request) => gate.handle(request),
      );
      gate.url = `http://host.docker.internal:${gate.server.addr.port}`;
      return gate;
    } catch (error) {
      gate.stream.destroy();
      throw error;
    }
  }
  private key(id: string): string {
    return id.toLowerCase().replace(/^0x/, "");
  }
  private payloadReady(id: string): void {
    const key = this.key(id);
    this.ready.add(key);
    for (const resolve of this.waiters.get(key) ?? []) resolve();
    if (this.ready.size > 128) this.ready.delete(this.ready.values().next().value!);
  }
  private async authenticate(request: Request): Promise<boolean> {
    try {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!token) return false;
      const [header, payload, signature, extra] = token.split(".");
      if (extra || !signature) return false;
      const decode = (value: string) =>
        Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      if (JSON.parse(new TextDecoder().decode(decode(header))).alg !== "HS256") return false;
      const { iat } = JSON.parse(new TextDecoder().decode(decode(payload)));
      if (typeof iat !== "number" || Math.abs(Date.now() / 1000 - iat) > 60) return false;
      return await crypto.subtle.verify(
        "HMAC",
        this.jwtKey,
        decode(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      );
    } catch {
      return false;
    }
  }
  private async waitPayload(id: string): Promise<void> {
    if (this.closed || this.logError) {
      throw new Error(`Engine log stream unavailable: ${this.logError}`);
    }
    const key = this.key(id);
    if (this.ready.has(key)) return;
    const waiting = Promise.withResolvers<void>();
    const entries = this.waiters.get(key) ?? new Set<() => void>();
    entries.add(waiting.resolve);
    this.waiters.set(key, entries);
    try {
      await deadline(waiting.promise, defaultTimeoutMs(), `Geth full payload ${id}`);
    } finally {
      entries.delete(waiting.resolve);
      if (!entries.size) this.waiters.delete(key);
    }
  }
  private async handle(request: Request): Promise<Response> {
    if (!await this.authenticate(request)) return new Response("Unauthorized", { status: 401 });
    try {
      const call = await request.json();
      if (call.method?.startsWith("engine_forkchoiceUpdated") && call.params?.[1]) {
        const timestamp = Number(BigInt(call.params[1].timestamp));
        // Speculative preparation during a pause would expire after Geth's real 12 s deadline.
        if (timestamp * 1000 > this.nowMs) call.params[1] = null;
      }
      if (call.method?.startsWith("engine_getPayloadV")) await this.waitPayload(call.params[0]);
      return await fetch(this.upstream, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: request.headers.get("authorization")!,
        },
        body: JSON.stringify(call),
        signal: AbortSignal.timeout(defaultTimeoutMs()),
      });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.stream?.destroy();
    for (const entries of this.waiters.values()) for (const resolve of entries) resolve();
    await this.server?.shutdown();
  }
}
