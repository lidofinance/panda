import assert from "node:assert/strict";
import { JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { waitFor } from "../../../src/http.ts";
import { StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { SnapshotConsumer } from "../../shared/tests/snapshot_consumer.ts";

const id = `snapshot-consumer-${crypto.randomUUID().slice(0, 8)}`;
const store = new StateStore(id);
const directory = `.cache/snapshot-consumers/${id}`;
const started = performance.now();
let net: Devnet | undefined;
let consumer: SnapshotConsumer | undefined;
let provider: JsonRpcProvider | undefined;
let signer!: NonceManager;
let passed = false;
function connectProvider() {
  provider = new JsonRpcProvider(net!.url, 1337, { staticNetwork: true, cacheTimeout: -1 });
  signer = new NonceManager(new Wallet(privateKey, provider));
}
async function send(value: bigint) {
  await net!.setAutomine(true);
  const transaction = await signer.sendTransaction({ to: account, value, gasLimit: 21_000 });
  const receipt = await waitFor(
    "consumer fixture transaction",
    async () => await provider!.getTransactionReceipt(transaction.hash) ?? undefined,
    60_000,
  );
  assert.equal(receipt.status, 1);
  await net!.setAutomine(false);
  return transaction.hash;
}
try {
  net = await Devnet.start({ id, profile: "gloas" });
  connectProvider();
  consumer = new SnapshotConsumer(net, directory);
  await consumer.start();
  const preserved = await send(1n);
  const saved = await net.status();
  const oldHistory = await consumer.waitFor(saved);
  const snapshot = await net.createSnapshot();
  const discarded = await send(2n);
  await net.advanceSlots(2);
  const future = await net.status();
  const futureHistory = await consumer.waitFor(future);
  assert(futureHistory.execution.some((block) => block.transactions.includes(preserved)));
  assert(futureHistory.execution.some((block) => block.transactions.includes(discarded)));
  assert(futureHistory.consensus.length > oldHistory.consensus.length);
  const cachedNonce = await signer.getNonce("pending");

  // Required integration order: freeze consumer writes before replacing the canonical history.
  await consumer.stop();
  await net.restoreSnapshot(snapshot);
  assert.deepEqual(
    await consumer.read(),
    futureHistory,
    "Panda must not modify an external database",
  );
  const restoredNonce = Number(
    BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "pending"])),
  );
  assert(cachedNonce > restoredNonce, "fixture must actually have a stale nonce cache");
  provider!.destroy();
  connectProvider();
  assert.equal(await signer.getNonce("pending"), restoredNonce);
  await consumer.reset();
  await consumer.start();
  const replay = await consumer.waitFor(saved);
  assert.notEqual(replay.instance, futureHistory.instance, "consumer must be a fresh process");
  assert.deepEqual(
    replay.execution,
    oldHistory.execution,
    "replay must include pre-snapshot history from genesis",
  );
  assert.deepEqual(replay.consensus, oldHistory.consensus, "CL-dependent history must rewind too");
  assert.equal(replay.execution[0].number, 0);
  assert.equal(replay.consensus[0].slot, 0);
  assert(replay.execution.some((block) => block.transactions.includes(preserved)));
  assert(!replay.execution.some((block) => block.transactions.includes(discarded)));
  assert(!replay.consensus.some((block) => block.root === futureHistory.consensus.at(-1)!.root));
  const next = await send(3n);
  const continued = await consumer.waitFor(await net.status());
  assert(continued.execution.some((block) => block.transactions.includes(next)));
  assert(!continued.execution.some((block) => block.transactions.includes(discarded)));
  await profileReport(saved, "snapshot-consumer", {
    passed: true,
    elapsedMs: performance.now() - started,
    savedSlot: saved.slot,
    futureSlot: future.slot,
    restoredSlot: replay.cursor.consensus,
    cachedNonce,
    restoredNonce,
    preserved,
    discarded,
    next,
    replayedExecutionBlocks: replay.execution.length,
    replayedConsensusBlocks: replay.consensus.length,
    continuedExecutionBlocks: continued.execution.length,
    independentDatabase: true,
    freshConsumerProcess: true,
  });
  passed = true;
} finally {
  try {
    await consumer?.stop();
  } finally {
    provider?.destroy();
    await net?.close();
  }
  if (passed) {
    assert.equal(await store.active(), undefined);
    await Deno.remove(store.root, { recursive: true });
    await Deno.remove(directory, { recursive: true });
  }
}
