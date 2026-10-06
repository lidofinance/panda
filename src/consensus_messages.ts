import { defaultTimeoutMs, json, waitFor } from "./http.ts";

/**
 * Real-time bound for Lighthouse's cached-head update after it announced a new head (observed:
 * about 30 ms after a cold state load). It stays well below the VC's 12 s HTTP timeout.
 */
const headWaitMs = 5_000;

export interface ConsensusMessage {
  path: string;
  headers: [string, string][];
  body: number[];
}

const payloads = "/eth/v1/beacon/pool/payload_attestations";
const attestations = "/eth/v2/beacon/pool/attestations";
const sync = "/eth/v1/beacon/pool/sync_committees";
const paths = new Set([payloads, attestations, sync]);
const encoder = new TextEncoder();

interface Vote {
  slot: number;
  body: Uint8Array;
  identity?: string;
}

function uint64(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Invalid consensus integer");
  }
  const normalized = value.replace(/^0+/, "") || "0";
  if (normalized.length > 20 || BigInt(normalized) > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Consensus integer exceeds uint64");
  }
  return normalized;
}

function votes(message: ConsensusMessage): Vote[] {
  if (!paths.has(message.path)) throw new Error("Unknown consensus submission route");
  const headers = new Headers(message.headers);
  const type = headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (headers.has("content-encoding")) throw new Error("Encoded consensus submissions unsupported");
  const bytes = Uint8Array.from(message.body);
  if (type === "application/octet-stream" && message.path === payloads) {
    // The pinned Gloas SignedPayloadAttestation is a fixed-size SSZ list element.
    if (bytes.length % 146) throw new Error("Invalid payload attestation SSZ length");
    const result: Vote[] = [];
    for (let offset = 0; offset < bytes.length; offset += 146) {
      const body = bytes.slice(offset, offset + 146);
      const slot = Number(new DataView(body.buffer).getBigUint64(40, true));
      if (!Number.isSafeInteger(slot)) throw new Error("Unsafe consensus slot");
      result.push({ slot, body });
    }
    return result;
  }
  if (type !== "application/json") throw new Error("Unsupported consensus content type");
  const items = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Array.isArray(items)) throw new Error("Expected a consensus message list");
  return items.map((item) => {
    const value = message.path === sync ? item?.slot : item?.data?.slot;
    if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error("Invalid consensus slot");
    }
    return {
      slot: Number(value),
      body: encoder.encode(JSON.stringify([item])),
      identity: message.path === attestations
        ? `attestation:${uint64(item?.data?.target?.epoch)}:${uint64(item?.attester_index)}`
        : message.path === sync
        ? `sync:${uint64(value)}:${uint64(item?.validator_index)}`
        : undefined,
    };
  });
}

/** Panda refused a submission before it reached the Beacon node; native state is unchanged. */
export class ConsensusAdmissionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Original signed Beacon submissions needed by a cold network snapshot. */
export class ConsensusMessages {
  private entries: { message: ConsensusMessage; newest: number; bytes: number }[] = [];
  private epoch = -1;
  private bytes = 0;
  private pending = 0;
  private failure?: string;
  private queue = Promise.resolve();
  constructor(readonly slot: () => number, readonly maxBytes = 16 * 1024 ** 2) {}

  /** Restore captured evidence only into an unused buffer, before any new validator can sign. */
  restore(messages: ConsensusMessage[]): void {
    if (this.pending || this.entries.length || this.failure) {
      throw new Error("Consensus capture must be empty before restore");
    }
    validateConsensusMessages(messages, this.slot(), this.maxBytes);
    const entries = messages.map((message) => {
      const parsed = votes(message);
      return {
        message: structuredClone(message),
        newest: parsed.reduce((last, vote) => Math.max(last, vote.slot), 0),
        bytes: message.body.length + encoder.encode(JSON.stringify(message.headers)).length,
      };
    });
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (entries.length > 4096 || bytes > this.maxBytes) {
      throw new Error("Consensus capture capacity exceeded");
    }
    this.entries = entries;
    this.bytes = bytes;
  }

  async idle(): Promise<void> {
    await this.queue;
  }

  /** Keep normal forwarding available, but never claim an untracked mutation was saved. */
  refuseSnapshot(reason: string): void {
    this.failure ??= reason;
  }

  private prune(): void {
    const epoch = Math.floor(this.slot() / 32);
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    // Keep the prior epoch's first attestation observations, even outside the replay slot window.
    // A mixed batch stays intact until every message is older than this conservative lower bound.
    const oldest = Math.max(0, (epoch - 1) * 32);
    this.entries = this.entries.filter((entry) => entry.newest >= oldest);
    this.bytes = this.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }

  forward(request: Request, target: string): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !paths.has(url.pathname)) {
      return fetch(new Request(target + url.pathname + url.search, request), {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(defaultTimeoutMs())]),
      });
    }
    this.prune();
    if (this.pending + this.entries.length >= 4096) {
      return Promise.reject(
        new ConsensusAdmissionError("Consensus capture capacity exceeded", 503),
      );
    }
    this.pending++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(defaultTimeoutMs())]);
    // Serialize both ingress paths to preserve request order. Native reprocessing can reorder
    // items within one batch; preflight separately refuses ambiguous duplicate contents.
    const result = this.queue.then(() => this.capture(request, target, signal));
    this.queue = result.then(() => {}, () => {});
    return result.finally(() => this.pending--);
  }

  private async capture(request: Request, target: string, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const headers = [...request.headers].filter(([key]) =>
      ["content-type", "eth-consensus-version", "content-encoding"].includes(key)
    );
    const reader = request.body?.getReader();
    const cancel = () => {
      void reader?.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let length = encoder.encode(JSON.stringify(headers)).length;
    try {
      if (length + this.bytes > this.maxBytes) {
        throw new ConsensusAdmissionError("Consensus capture capacity exceeded", 503);
      }
      while (reader) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        length += value.byteLength;
        if (length + this.bytes > this.maxBytes) {
          throw new ConsensusAdmissionError("Consensus capture capacity exceeded", 503);
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader?.cancel();
      // Nothing was forwarded: a failed upload cannot have changed native state.
      throw error instanceof ConsensusAdmissionError
        ? error
        : new ConsensusAdmissionError(`Consensus submission upload failed: ${error}`, 400);
    } finally {
      signal.removeEventListener("abort", cancel);
      reader?.releaseLock();
    }
    const body = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    const url = new URL(request.url);
    const entry: ConsensusMessage = { path: url.pathname, headers, body: [...body] };
    let parsed: Vote[];
    try {
      parsed = votes(entry); // Refuse unsupported capture before it can change native state.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConsensusAdmissionError(message, /unsupported/i.test(message) ? 415 : 400);
    }
    if (signal.aborted) {
      throw new ConsensusAdmissionError(`Consensus submission aborted: ${signal.reason}`, 503);
    }
    if (url.pathname === sync) {
      await this.awaitHead(body, target, signal);
      // The hold forwarded nothing; a cancellation during it cannot have changed native state.
      if (signal.aborted) {
        throw new ConsensusAdmissionError(`Consensus submission aborted: ${signal.reason}`, 503);
      }
    }
    try {
      const response = await fetch(target + url.pathname + url.search, {
        method: "POST",
        headers: request.headers,
        body,
        redirect: "manual",
        signal,
      });
      if (response.status === 200) {
        if (parsed.length) {
          this.entries.push({
            message: entry,
            newest: parsed.reduce((last, vote) => Math.max(last, vote.slot), 0),
            bytes: length,
          });
          this.bytes += length;
        }
      } else {
        // A batch error can follow a partial import; an empty pool is not proof of rejection.
        this.failure = `Unresolved consensus submission: HTTP ${response.status}`;
      }
      return response;
    } catch (error) {
      this.failure = "Unresolved consensus submission: response lost";
      throw error;
    }
  }

  /**
   * Lighthouse publishes the SSE head event while importing a block, before it updates the cached
   * head. The VC signs sync votes on that event, but the controlled sync barrier only completes
   * while the votes' root is the cached head. Hold current-slot votes for a block of this slot
   * until it is the head; any other vote (earlier block, unknown root, lookup error) is unchanged.
   */
  private async awaitHead(body: Uint8Array, target: string, signal: AbortSignal): Promise<void> {
    let root: unknown;
    try {
      const items = JSON.parse(new TextDecoder().decode(body));
      root = items[0]?.beacon_block_root;
      if (
        typeof root !== "string" ||
        !items.every((item: { slot?: unknown; beacon_block_root?: unknown }) =>
          item?.slot === String(this.slot()) && item?.beacon_block_root === root
        )
      ) return;
      const block = await json<{ data: { header: { message: { slot: string } } } }>(
        `${target}/eth/v1/beacon/headers/${root}`,
        { signal },
      );
      if (block.data.header.message.slot !== String(this.slot())) return;
    } catch {
      return;
    }
    const started = performance.now();
    let held = false;
    try {
      await waitFor("Beacon head for current sync votes", async () => {
        if (signal.aborted) return true; // Forwarding reports the cancellation itself.
        const head = await json<{ data: { root: string } }>(
          `${target}/eth/v1/beacon/headers/head`,
          { signal },
        );
        if (head.data.root === root) return true;
        held = true;
      }, headWaitMs);
    } catch {
      // A competing head is ordinary consensus; forward unchanged rather than stall the client.
    }
    if (held) {
      console.log(JSON.stringify({
        event: "sync-votes-held-for-head",
        root,
        slot: this.slot(),
        elapsedMs: performance.now() - started,
      }));
    }
  }

  snapshot(): ConsensusMessage[] {
    if (this.pending) throw new Error("Consensus submissions are still in flight");
    if (this.failure) throw new Error(this.failure);
    this.prune();
    const messages = this.entries.map((entry) => entry.message);
    prepareReplay(messages, this.slot());
    return structuredClone(messages);
  }
}

/** Validate untrusted archive replay evidence before preparing a candidate or touching clients. */
export function validateConsensusMessages(
  value: unknown,
  slot: number,
  maxBytes = 16 * 1024 ** 2,
): asserts value is ConsensusMessage[] {
  if (!Array.isArray(value)) throw new Error("Invalid consensus capture array");
  if (value.length > 4096) throw new Error("Consensus capture capacity exceeded");
  let bytes = 0;
  for (const entry of value) {
    if (
      !entry || typeof entry !== "object" || !paths.has(entry.path) ||
      !Array.isArray(entry.headers) || !Array.isArray(entry.body)
    ) {
      throw new Error("Invalid consensus capture message");
    }
    for (const header of entry.headers) {
      if (
        !Array.isArray(header) || header.length !== 2 ||
        typeof header[0] !== "string" || typeof header[1] !== "string" ||
        !["content-type", "eth-consensus-version", "content-encoding"].includes(
          header[0].toLowerCase(),
        )
      ) {
        throw new Error("Invalid consensus capture header");
      }
    }
    bytes += entry.body.length + encoder.encode(JSON.stringify(entry.headers)).length;
    if (bytes > maxBytes) throw new Error("Consensus capture capacity exceeded");
    if (
      !entry.body.every((byte: unknown) =>
        typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255
      )
    ) {
      throw new Error("Invalid consensus capture bytes");
    }
  }
  prepareReplay(value, slot);
}

/** Replay only at a completed slot tail, before any replacement validator can sign. */
function prepareReplay(
  messages: ConsensusMessage[],
  slot: number,
) {
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("Invalid snapshot slot");
  const observed = new Map<string, Uint8Array>();
  const pending: { message: ConsensusMessage; vote: Vote }[] = [];
  for (const message of messages) {
    for (const vote of votes(message)) {
      // Native gossip tolerance can admit S+1 at the saved tail. Replaying that future state
      // is not yet established; refuse capture instead of silently dropping or importing it.
      if (vote.slot > slot) {
        throw new Error(`Future consensus message at slot ${vote.slot}; snapshot slot is ${slot}`);
      }
      if (vote.identity) {
        const previous = observed.get(vote.identity);
        // HTTP 200 does not identify the imported epoch winner: a queued unknown block/envelope
        // can let a later batch item win first. Sync duplicate overrides also depend on the head
        // at arrival, which may differ from the saved head. Accept identical repeats, refusing
        // other contents (including field-order/format differences) before stopping or replaying.
        if (
          previous !== undefined &&
          (previous.length !== vote.body.length ||
            !previous.every((byte, index) => byte === vote.body[index]))
        ) {
          throw new Error(
            `Ambiguous ${
              message.path === sync ? "sync message" : "attestation"
            } duplicate: different signed contents`,
          );
        }
        observed.set(vote.identity, vote.body);
      }
      const oldest = message.path === attestations ? Math.max(0, slot - 3) : slot;
      if (vote.slot >= oldest) pending.push({ message, vote });
    }
  }
  return pending;
}

export async function replayConsensusMessages(
  messages: ConsensusMessage[],
  target: string,
  slot: number,
): Promise<void> {
  // Preserve import order, including the order of conflicting/duplicate messages within a batch.
  for (const { message, vote } of prepareReplay(messages, slot)) {
    const response = await fetch(target + message.path, {
      method: "POST",
      headers: message.headers,
      body: new Uint8Array(vote.body),
      redirect: "manual",
      signal: AbortSignal.timeout(defaultTimeoutMs()),
    });
    const body = await response.text();
    if (response.status !== 200) {
      throw new Error(`Consensus replay failed: ${response.status} ${body}`);
    }
  }
}
