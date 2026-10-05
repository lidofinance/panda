import { deadline, defaultTimeoutMs, forwardedHeaders } from "./http.ts";
import { Serial } from "./time.ts";

export interface RequestLease {
  readonly signal: AbortSignal;
  release(): void;
}
export type IngressPhase = "ready" | "maintenance" | "parked" | "faulted";

/** Admission and lifecycle synchronization are independent of a healthy Timeline. */
export class Ingress {
  private phase: IngressPhase = "ready";
  private operation?: string;
  private error?: string;
  private pendingMaintenance = 0;
  private generation = 0;
  private readonly lifecycle = new Serial();
  private readonly finite = new Set<AbortController>();
  private readonly streams = new Set<AbortController>();
  private readonly drained = new Set<() => void>();

  get status() {
    return {
      phase: this.phase,
      ready: this.phase === "ready",
      generation: this.generation,
      active: this.finite.size,
      streams: this.streams.size,
      operation: this.operation,
      error: this.error,
    };
  }
  private lease(stream: boolean): RequestLease {
    if (this.phase !== "ready") throw new Error(`Panda ingress is ${this.phase}`);
    const controller = new AbortController();
    const set = stream ? this.streams : this.finite;
    set.add(controller);
    return {
      signal: controller.signal,
      release: () => {
        set.delete(controller);
        if (!this.finite.size && !this.streams.size) { for (const done of this.drained) done(); }
      },
    };
  }
  enter(): RequestLease {
    return this.lease(false);
  }
  stream(): RequestLease {
    return this.lease(true);
  }
  /** Do not release a proxy lease when only the upstream response headers have arrived. */
  holdResponse(response: Response, lease: RequestLease): Response {
    if (!response.body) {
      lease.release();
      return response;
    }
    const reader = response.body.getReader();
    let target: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;
    const finish = () => {
      ended = true;
      lease.signal.removeEventListener("abort", abort);
      lease.release();
    };
    const abort = () => {
      if (ended) return;
      ended = true;
      target.error(lease.signal.reason);
      // Cancellation may itself be asynchronous. Keep the lease until it has completed.
      void reader.cancel(lease.signal.reason).finally(finish).catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        target = controller;
        lease.signal.addEventListener("abort", abort, { once: true });
        if (lease.signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (ended) return;
          if (next.done) {
            finish();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          if (!ended) {
            finish();
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        ended = true;
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: forwardedHeaders(response),
    });
  }
  private abortStreams(): void {
    for (const stream of this.streams) stream.abort(new Error("Panda session entered maintenance"));
    // The proxy releases each stream lease only after upstream cancellation has completed.
  }
  /** Discard requests only for an explicit branch replacement, never for snapshot creation. */
  cancelPending(reason: Error): void {
    for (const request of this.finite) request.abort(reason);
    for (const stream of this.streams) stream.abort(reason);
  }
  private async drain(timeoutMs: number): Promise<void> {
    if (!this.finite.size && !this.streams.size) return;
    const idle = Promise.withResolvers<void>();
    this.drained.add(idle.resolve);
    try {
      await deadline(idle.promise, timeoutMs, "Panda request drain");
    } catch (error) {
      for (const request of this.finite) request.abort(error);
      throw error;
    } finally {
      this.drained.delete(idle.resolve);
    }
  }
  maintenance<T>(
    name: string,
    work: () => Promise<T>,
    timeoutMs = defaultTimeoutMs(),
    beforeDrain?: () => Promise<void>,
  ): Promise<T> {
    this.pendingMaintenance++;
    this.phase = "maintenance";
    this.abortStreams();
    return this.lifecycle.run(async () => {
      this.operation = name;
      this.phase = "maintenance";
      try {
        await beforeDrain?.();
        await this.drain(timeoutMs);
        const result = await work();
        this.phase = "parked";
        this.error = undefined;
        return result;
      } catch (error) {
        this.fault(error);
        throw error;
      } finally {
        this.pendingMaintenance--;
      }
    });
  }
  /** Publish only after the caller has validated the replacement session. */
  resume(): void {
    if (this.pendingMaintenance || this.finite.size || this.streams.size) {
      throw new Error("Cannot resume while lifecycle or requests are active");
    }
    this.abortStreams();
    this.generation++;
    this.phase = "ready";
    this.operation = undefined;
    this.error = undefined;
  }
  fault(error: unknown): void {
    this.phase = "faulted";
    this.error = String(error);
    this.abortStreams();
  }
}
