import { defaultTimeoutMs } from "./http.ts";

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

/** Original signed Beacon submissions needed by a cold network snapshot. */
export class ConsensusMessages {
  private entries: { message: ConsensusMessage; newest: number; bytes: number }[] = [];
  private epoch = -1;
  private bytes = 0;
  private pending = 0;
  private failure?: string;
  private queue = Promise.resolve();
  constructor(readonly slot: () => number, readonly maxBytes = 16 * 1024 ** 2) {}

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
      return Promise.reject(new Error("Consensus capture capacity exceeded"));
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
        throw new Error("Consensus capture capacity exceeded");
      }
      while (reader) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        length += value.byteLength;
        if (length + this.bytes > this.maxBytes) {
          throw new Error("Consensus capture capacity exceeded");
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader?.cancel();
      throw error;
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
    const parsed = votes(entry); // Refuse unsupported capture before it can change native state.
    signal.throwIfAborted();
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

  snapshot(): ConsensusMessage[] {
    if (this.pending) throw new Error("Consensus submissions are still in flight");
    if (this.failure) throw new Error(this.failure);
    this.prune();
    const messages = this.entries.map((entry) => entry.message);
    prepareReplay(messages, this.slot());
    return structuredClone(messages);
  }
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
