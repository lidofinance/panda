import assert from "node:assert/strict";
import { delay } from "../../../src/http.ts";

interface AutomineNetwork {
  setAutomine(enabled: boolean): Promise<unknown>;
  status(): Promise<{
    now: number;
    slot: number;
    automineError?: string;
    el: { hash: string; number: string; timestamp: string };
  }>;
  rpc<T>(method: string, params: unknown[]): Promise<T>;
}

export async function assertFeeCappedTransactionPaused(
  net: AutomineNetwork,
  submit: () => Promise<string>,
  observe: () => Promise<unknown> = () => delay(1000),
): Promise<void> {
  // An EL receipt can precede the end of the corresponding Consensus.move/stepSlot.
  // Drain that earlier work before taking the baseline for this transaction.
  await net.setAutomine(false);
  const before = await net.status();
  assert.equal(before.automineError, undefined, "automine failed before the fee-cap check");
  let hash: string;
  try {
    await net.setAutomine(true);
    hash = await submit();
    await observe();
  } finally {
    // Include any work incorrectly started by this transaction in the final assertions.
    await net.setAutomine(false);
  }
  const after = await net.status();
  assert.equal(after.automineError, undefined, "automine failed during the fee-cap check");
  assert.equal(after.slot, before.slot, "fee-capped tx produced blocks");
  assert.equal(after.now, before.now, "fee-capped tx advanced protocol time");
  assert.equal(after.el.hash, before.el.hash, "fee-capped tx changed the EL head");
  assert.equal(after.el.timestamp, before.el.timestamp, "fee-capped tx changed the EL timestamp");
  assert.equal(
    await net.rpc("eth_getTransactionReceipt", [hash]),
    null,
    "fee-capped tx was included",
  );
}
