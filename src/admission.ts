import { Transaction } from "ethers";
import { dirname } from "node:path";
import { forwardedHeaders } from "./http.ts";
import { Serial } from "./time.ts";

/** Error classification is deliberately tied to the independently rebuilt P0 Geth. */
export const pinnedGethRevision = "5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186";
const submissions = new Set([
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
  "eth_sendTransaction",
  "eth_resend",
  "personal_sendTransaction",
  "personal_signAndSendTransaction",
]);
type State = "intent" | "accepted" | "ambiguous" | "confirmed" | "consumed" | "rejected";
export interface Admission {
  id: string;
  batch: string;
  index: number;
  method: string;
  rpcId?: unknown;
  hash?: string;
  sender?: string;
  nonce?: string;
  state: State;
  result?: unknown;
  error?: unknown;
  anchor?: { number: string; hash: string };
}
interface Journal {
  schema: 1;
  gethRevision: string;
  records: Admission[];
}
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const unresolved = (record: Admission) =>
  ["intent", "accepted", "ambiguous"].includes(record.state);
const hashValue = (value: unknown): value is string =>
  typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const quantity = (value: unknown): value is string =>
  typeof value === "string" && /^0x(?:0|[1-9a-f][\da-f]*)$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function checksum(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function identity(call: Record<string, unknown>): Partial<Admission> {
  const params = Array.isArray(call.params) ? call.params : [];
  try {
    if (call.method === "eth_sendRawTransaction" || call.method === "eth_sendRawTransactionSync") {
      if (typeof params[0] !== "string") return {};
      const tx = Transaction.from(params[0]);
      return {
        hash: tx.hash ?? undefined,
        sender: tx.from ?? undefined,
        nonce: `0x${tx.nonce.toString(16)}`,
      };
    }
    if (object(params[0])) {
      const { from, nonce } = params[0];
      return {
        sender: typeof from === "string" && /^0x[\da-f]{40}$/i.test(from) ? from : undefined,
        nonce: quantity(nonce) ? nonce : undefined,
      };
    }
  } catch {
    /* Geth validates raw input. Unsupported encodings remain reconcilable by its returned hash. */
  }
  return {};
}

function preAdmissionRejection(revision: string, entry: Admission, error: unknown): boolean {
  if (revision !== pinnedGethRevision || !object(error)) return false;
  // rpc/handler.go rejects argument decoding before invoking the API method.
  if (error.code === -32602) return true;
  if (error.code !== -32000 || typeof error.message !== "string") return false;
  if (entry.method !== "eth_sendRawTransaction" && entry.method !== "eth_sendRawTransactionSync") {
    return false;
  }
  // internal/ethapi/api.go: UnmarshalBinary runs before SubmitTransaction/SendTx.
  // core/txpool/validation.go wraps this signature error before LegacyPool.Add inserts the tx.
  // Do not classify "already known", temporary pool errors or sync-receipt timeouts as rejection.
  return error.message.startsWith("rlp:") || [
    "typed transaction too short",
    "transaction type not supported",
    "empty typed transaction bytes",
    "invalid transaction v, r, s values",
    "invalid sender: invalid transaction v, r, s values",
    "only replay-protected (EIP-155) transactions allowed over RPC",
  ].includes(error.message);
}

/** Durable receipt of submissions, not a replacement txpool and never a transaction retry queue. */
export class AdmissionLedger {
  private readonly serial = new Serial();
  private failure?: unknown;
  private constructor(readonly path: string, private journal: Journal) {}

  static async open(
    path: string,
    options: { gethRevision: string; create?: boolean },
  ): Promise<AdmissionLedger> {
    let journal: Journal;
    try {
      const stored = JSON.parse(await Deno.readTextFile(path));
      if (!object(stored) || stored.checksum !== await checksum(stored.payload)) {
        throw new Error("integrity check failed");
      }
      const value = stored.payload;
      if (
        !object(value) || value.schema !== 1 || value.gethRevision !== options.gethRevision ||
        !Array.isArray(value.records)
      ) {
        throw new Error("incompatible schema or Geth revision");
      }
      const ids = new Set<string>();
      for (const record of value.records) {
        if (
          !object(record) || typeof record.id !== "string" || ids.has(record.id) ||
          typeof record.batch !== "string" || !Number.isSafeInteger(record.index) ||
          typeof record.method !== "string" || !submissions.has(record.method) ||
          !["intent", "accepted", "ambiguous", "confirmed", "consumed", "rejected"].includes(
            String(record.state),
          )
        ) {
          throw new Error("invalid admission record");
        }
        ids.add(record.id);
      }
      journal = value as unknown as Journal;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) || options.create === false) {
        throw new Error(`Cannot open admission ledger: ${error}`);
      }
      journal = { schema: 1, gethRevision: options.gethRevision, records: [] };
      const ledger = new AdmissionLedger(path, journal);
      await ledger.change(() => {});
      return ledger;
    }
    return new AdmissionLedger(path, journal);
  }
  get records(): readonly Admission[] {
    return structuredClone(this.journal.records);
  }
  get pending(): readonly Admission[] {
    return this.records.filter(unresolved);
  }
  assertSettled(): void {
    if (this.failure) throw new Error(`Admission persistence faulted: ${this.failure}`);
    const pending = this.pending;
    if (pending.length) {
      throw new Error(
        `EL submissions unresolved: ${pending.map((r) => r.hash ?? r.id).join(", ")}`,
      );
    }
  }
  private change(update: (journal: Journal) => void): Promise<void> {
    return this.serial.run(async () => {
      if (this.failure) throw new Error(`Admission persistence faulted: ${this.failure}`);
      const next = structuredClone(this.journal);
      update(next);
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      try {
        await Deno.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
        try {
          const data = new TextEncoder().encode(
            JSON.stringify({ checksum: await checksum(next), payload: next }),
          );
          for (let offset = 0; offset < data.length;) {
            offset += await file.write(data.subarray(offset));
          }
          await file.sync();
        } finally {
          file.close();
        }
        await Deno.rename(temporary, this.path);
        const directory = await Deno.open(dirname(this.path), { read: true });
        try {
          await directory.sync();
        } finally {
          directory.close();
        }
        this.journal = next;
      } catch (error) {
        this.failure = error;
        throw new Error(`Admission persistence failed: ${error}`);
      } finally {
        try {
          await Deno.remove(temporary);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) this.failure ??= error;
        }
      }
    });
  }
  async forward(body: string, upstream: () => Promise<Response>): Promise<Response> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return await upstream();
    }
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const batch = crypto.randomUUID();
    const entries: Admission[] = [];
    for (const [index, call] of calls.entries()) {
      if (!object(call) || typeof call.method !== "string" || !submissions.has(call.method)) {
        continue;
      }
      entries.push({
        id: crypto.randomUUID(),
        batch,
        index,
        method: call.method,
        ...(Object.hasOwn(call, "id") ? { rpcId: call.id } : {}),
        ...identity(call),
        state: "intent",
      });
    }
    if (!entries.length) return await upstream();
    await this.change((journal) => journal.records.push(...entries));
    let response: Response;
    let text: string;
    try {
      response = await upstream();
      text = await response.text();
    } catch (error) {
      await this.change((journal) => {
        for (const entry of journal.records.filter((r) => r.batch === batch)) {
          entry.state = "ambiguous";
          entry.error = String(error);
        }
      });
      throw error;
    }
    let results: unknown[] = [];
    try {
      const parsed = JSON.parse(text);
      results = Array.isArray(parsed) ? parsed : [parsed];
    } catch { /* notification/transport response */ }
    await this.change((journal) => {
      for (const entry of journal.records.filter((r) => r.batch === batch)) {
        entry.state = "ambiguous";
        if (!Object.hasOwn(entry, "rpcId")) continue;
        // Duplicate IDs cannot be paired safely, including collisions with non-submission methods.
        if (
          calls.filter((call) =>
            object(call) && Object.hasOwn(call, "id") && call.id === entry.rpcId
          ).length !== 1
        ) continue;
        const matches = results.filter((result) => object(result) && result.id === entry.rpcId);
        if (matches.length !== 1 || !object(matches[0])) continue;
        const result = matches[0];
        if (
          !response.ok || result.jsonrpc !== "2.0" ||
          Object.hasOwn(result, "error") === Object.hasOwn(result, "result")
        ) continue;
        entry.result = result.result;
        entry.error = result.error;
        if (Object.hasOwn(result, "error")) {
          if (preAdmissionRejection(journal.gethRevision, entry, result.error)) {
            entry.state = "rejected";
          }
        } else {
          const resultHash = hashValue(result.result)
            ? result.result
            : object(result.result) && hashValue(result.result.transactionHash)
            ? result.result.transactionHash
            : undefined;
          if (
            resultHash && (!entry.hash || resultHash.toLowerCase() === entry.hash.toLowerCase())
          ) {
            entry.hash = resultHash;
            entry.state = "accepted";
          }
        }
      }
    });
    return new Response(text || null, {
      status: response.status,
      statusText: response.statusText,
      headers: forwardedHeaders(response),
    });
  }
  /** Call only with managed ingress drained and protocol advancement stopped. */
  async reconcile(rpc: Rpc): Promise<void> {
    const pending = this.pending;
    if (!pending.length) return;
    const head = await rpc("eth_getBlockByNumber", ["latest", false]);
    if (!object(head) || !hashValue(head.hash) || !quantity(head.number)) {
      throw new Error("Invalid canonical EL head");
    }
    const resolved = new Map<string, "confirmed" | "consumed">();
    for (const entry of pending) {
      if (entry.hash) {
        const receipt = await rpc("eth_getTransactionReceipt", [entry.hash]);
        if (
          object(receipt) && receipt.transactionHash === entry.hash &&
          quantity(receipt.blockNumber) && hashValue(receipt.blockHash) &&
          BigInt(receipt.blockNumber) <= BigInt(head.number)
        ) {
          const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
          if (
            object(block) && block.hash === receipt.blockHash &&
            block.number === receipt.blockNumber
          ) {
            resolved.set(entry.id, "confirmed");
            continue;
          }
        }
      }
      if (entry.sender && entry.nonce) {
        const nonce = await rpc("eth_getTransactionCount", [entry.sender, {
          blockHash: head.hash,
          requireCanonical: true,
        }]);
        if (quantity(nonce) && BigInt(nonce) > BigInt(entry.nonce)) {
          resolved.set(entry.id, "consumed");
        }
      }
    }
    const check = await rpc("eth_getBlockByNumber", ["latest", false]);
    if (!object(check) || check.hash !== head.hash || check.number !== head.number) {
      throw new Error("EL head changed during admission reconciliation");
    }
    if (resolved.size) {
      await this.change((journal) => {
        for (const entry of journal.records) {
          const state = resolved.get(entry.id);
          if (state && unresolved(entry)) {
            entry.state = state;
            entry.anchor = { number: head.number as string, hash: head.hash as string };
          }
        }
      });
    }
  }
}
