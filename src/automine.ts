import { type ExecutionBlock } from "./consensus.ts";
import { rpc, withWatchdog } from "./http.ts";
import { type Timeline } from "./time.ts";

export interface PoolTransaction {
  hash: string;
  from: string;
  nonce: string;
  gas: string;
  value: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}
export function executable(
  tx: PoolTransaction,
  nonce: bigint,
  balance: bigint,
  baseFee: bigint,
  gasLimit: bigint,
): boolean {
  const fee = BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? "0x0");
  const tip = tx.maxPriorityFeePerGas === undefined
    ? fee - baseFee
    : BigInt(tx.maxPriorityFeePerGas);
  return BigInt(tx.nonce) === nonce && fee >= baseFee && tip >= 1n &&
    BigInt(tx.gas) <= gasLimit && balance >= BigInt(tx.value) + BigInt(tx.gas) * fee;
}
export class Automine {
  private readonly cancelled = new AbortController();
  enabled = false;
  error?: string;
  private running = false;
  private requested = 0;
  private handled = 0;
  private stopped = false;
  private active?: Promise<void>;
  constructor(readonly el: string, readonly time: Timeline) {}
  async set(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (enabled) this.notify();
    else await this.active;
  }
  notify(): void {
    if (!this.enabled || this.stopped) return;
    this.requested++;
    this.start();
  }
  private start(): void {
    if (this.running || !this.enabled || this.stopped) return;
    this.running = true;
    this.active = this.drain().catch((error) => {
      this.handled = this.requested;
      if (!this.stopped) {
        this.error = String(error);
        console.error(JSON.stringify({ event: "automine-error", error: this.error }));
      }
    }).finally(() => {
      this.running = false;
      if (this.requested > this.handled) this.start();
    });
  }
  private rpc<T>(method: string, args: unknown[] = []): Promise<T> {
    return rpc<T>(this.el, method, args, withWatchdog(this.cancelled.signal));
  }
  async candidates(): Promise<string[]> {
    const pool = await this.rpc<{ pending: Record<string, Record<string, PoolTransaction>> }>(
      "txpool_content",
    );
    const head = await this.rpc<ExecutionBlock & { gasUsed: string }>("eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const gasLimit = BigInt(head.gasLimit);
    const target = gasLimit / 2n;
    const fee = BigInt(head.baseFeePerGas);
    const used = BigInt(head.gasUsed);
    const delta = fee * (used > target ? used - target : target - used) / target / 8n;
    const nextFee = used > target ? fee + (delta > 0n ? delta : 1n) : fee - delta;
    const result: string[] = [];
    for (const [sender, entries] of Object.entries(pool.pending)) {
      const [nonce, balance] = await Promise.all([
        this.rpc<string>("eth_getTransactionCount", [sender, "latest"]),
        this.rpc<string>("eth_getBalance", [sender, "latest"]),
      ]);
      const first = Object.values(entries).find((tx) => BigInt(tx.nonce) === BigInt(nonce));
      if (first && executable(first, BigInt(nonce), BigInt(balance), nextFee, gasLimit)) {
        result.push(first.hash);
      }
    }
    return result.sort();
  }
  private async drain(): Promise<void> {
    // Bounded even if an EL advertises a transaction which its payload builder cannot include.
    for (let blocks = 0; blocks < 256 && this.enabled && !this.stopped; blocks++) {
      const generation = this.requested;
      this.handled = generation;
      const before = await this.candidates();
      if (!before.length) {
        if (generation !== this.requested) {
          blocks--;
          continue;
        }
        return;
      }
      if (!this.enabled || this.stopped) return;
      await this.time.stepSlot();
      const after = await this.candidates();
      if (before.join() === after.join() && generation === this.requested) return;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.enabled = false;
    this.cancelled.abort(new Error("Panda automine stopped"));
    await this.active;
  }
}
