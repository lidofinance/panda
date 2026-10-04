import assert from "node:assert/strict";
import { toBeHex, type TransactionRequest, Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { finalizedExecutionHash } from "../../../src/consensus.ts";
import { GENERATION, Infrastructure, LABEL, ROLE } from "../../../src/docker.ts";
import { Network } from "../../../src/network.ts";
import { sha256 } from "../../../src/profiles.ts";
import { SnapshotStore } from "../../../src/snapshots.ts";
import { StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { exportSigningHistory } from "../../shared/tests/signing_history.ts";

const id = `snapshots-${crypto.randomUUID().slice(0, 8)}`;
const store = new StateStore(id);
const infra = new Infrastructure(id);
const started = performance.now();
let net: Devnet | undefined;
let passed = false;
const send = async (transaction: TransactionRequest = {}) => {
  const raw = await new Wallet(privateKey).signTransaction({
    type: 2,
    chainId: 1337,
    nonce: Number(BigInt(await net!.rpc<string>("eth_getTransactionCount", [account, "latest"]))),
    to: account,
    gasLimit: 21_000,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 1n,
    ...transaction,
  });
  const started = performance.now();
  await net!.setAutomine(true);
  const hash = await net!.rpc<string>("eth_sendRawTransaction", [raw]);
  const receipt = await net!.waitForService(
    "snapshot branch transaction",
    async () =>
      await net!.rpc<
        {
          status: string;
          blockNumber: string;
          contractAddress: string | null;
        } | null
      >(
        "eth_getTransactionReceipt",
        [hash],
      ) ?? undefined,
    120_000,
  );
  await net!.setAutomine(false);
  assert.equal(receipt.status, "0x1");
  return { hash, receipt, elapsedMs: performance.now() - started };
};
const beaconState = async () => {
  const response = await fetch(`${net!.beaconUrl}/eth/v2/debug/beacon/states/head`, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status !== 200) {
    assert.fail(`Beacon SSZ state: HTTP ${response.status}: ${await response.text()}`);
  }
  assert.match(response.headers.get("content-type") ?? "", /application\/octet-stream/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 0, "empty Beacon SSZ state");
  return bytes;
};
async function allocatedBytes(path: string): Promise<number> {
  const result = await new Deno.Command("du", {
    args: ["-sk", path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  const bytes = Number(new TextDecoder().decode(result.stdout).trim().split(/\s+/)[0]) * 1024;
  assert(Number.isSafeInteger(bytes) && bytes >= 0, "invalid allocated disk measurement");
  return bytes;
}
try {
  net = await Devnet.start({ id, profile: "gloas" });
  // Real EVM fixture: constructor returns runtime; each call stores calldata word 0 at slot 0.
  // No compiler or external artifact is needed for this minimal mutable contract.
  const runtime = "0x60003560005500";
  const deployment = await send({
    to: null,
    value: 0n,
    data: `0x6007600c60003960076000f3${runtime.slice(2)}`,
    gasLimit: 12_000_000,
  });
  const contract = deployment.receipt.contractAddress;
  assert(contract);
  assert.equal(await net.rpc("eth_getCode", [contract, "latest"]), runtime);
  const write = (value: bigint) =>
    // Amsterdam charges state gas for allocating the first storage slot (EIP-8037).
    send({ to: contract, value: 0n, data: toBeHex(value, 32), gasLimit: 12_000_000 });
  const included = await write(0x123456789abcdefn);
  await net.advanceSlots(1);
  // Expected chain state is read independently before calling the snapshot implementation.
  const saved = await net.status();
  const block = await net.beacon("/eth/v2/beacon/blocks/head");
  const balance = await net.rpc("eth_getBalance", [account, "latest"]);
  const nonce = await net.rpc("eth_getTransactionCount", [account, "latest"]);
  const storage = await net.rpc<string>("eth_getStorageAt", [contract, "0x0", "latest"]);
  assert.equal(BigInt(storage), 0x123456789abcdefn);
  const state = await beaconState();
  const history = await exportSigningHistory(await Network.manifest(id));
  const checkSavedState = async () => {
    assert.equal(await net!.rpc("eth_getStorageAt", [contract, "0x0", "latest"]), storage);
    assert.deepEqual(
      await net!.rpc("eth_getTransactionReceipt", [included.hash]),
      included.receipt,
    );
    assert.deepEqual(await beaconState(), state, "full Beacon SSZ state changed");
  };
  const diskBeforeCapture = await allocatedBytes(store.root);
  const captureStarted = performance.now();
  const createId = crypto.randomUUID();
  const snapshot = await net.createSnapshot({ operationId: createId });
  const captureMs = performance.now() - captureStarted;
  assert.equal((await net.status()).now, saved.now);
  await checkSavedState();
  assert.deepEqual(await net.createSnapshot({ operationId: createId }), snapshot);
  const archive = await new SnapshotStore(store, infra).read(snapshot.id);
  const snapshotBytes = Object.values(archive.files).reduce((total, file) => total + file.size, 0);
  const diskAfterCapture = await allocatedBytes(store.root);
  const archiveAllocatedBytes = await allocatedBytes(`${store.root}/snapshots/${snapshot.id}`);
  const restores = [];
  for (const branch of ["live", "repeated", "crashed beacon"]) {
    const transaction = await write(0xfedcba987654321n);
    assert.notEqual(await net.rpc("eth_getStorageAt", [contract, "0x0", "latest"]), storage);
    await net.advanceSlots(2);
    const before: Awaited<ReturnType<Devnet["lifecycle"]>> = await net.lifecycle();
    if (branch === "crashed beacon") {
      const labels = [`${LABEL}=${id}`, `${GENERATION}=${before.generation}`, `${ROLE}=bn`];
      const clients = await infra.docker.listContainers({ all: true, filters: { label: labels } });
      assert.equal(clients.length, 1);
      assert.equal(clients[0].Labels[LABEL], id);
      assert.equal(clients[0].Labels[GENERATION], before.generation);
      await infra.docker.getContainer(clients[0].Id).kill({ signal: "SIGKILL" });
      await assert.rejects(net.stepSlot());
      assert.equal((await net.lifecycle()).ready, false);
    }
    const operationId = crypto.randomUUID();
    const started = performance.now();
    const restored = await net.restoreSnapshot(snapshot, { operationId });
    const restoreMs = performance.now() - started;
    const after = await net.status();
    assert.equal(after.now, saved.now);
    assert.equal(after.slot, saved.slot);
    assert.equal(after.el.hash, saved.el.hash);
    assert.equal(after.automine, false);
    assert.deepEqual(await net.beacon("/eth/v2/beacon/blocks/head"), block);
    assert.equal(await net.rpc("eth_getBalance", [account, "latest"]), balance);
    assert.equal(await net.rpc("eth_getTransactionCount", [account, "latest"]), nonce);
    assert.equal(await net.rpc("eth_getTransactionReceipt", [transaction.hash]), null);
    assert.deepEqual(await exportSigningHistory(await Network.manifest(id)), history);
    await checkSavedState();
    const lifecycle = await net.lifecycle();
    assert.equal(lifecycle.cleanup?.state, "succeeded");
    const generations = [];
    for await (const entry of Deno.readDir(`${store.root}/generations`)) {
      generations.push(entry.name);
    }
    assert.deepEqual(generations, [lifecycle.generation], "discarded generations were not cleaned");
    assert.notEqual(lifecycle.generation, before.generation);
    assert.notEqual(lifecycle.sessionId, before.sessionId);
    assert.deepEqual(await net.restoreSnapshot(snapshot, { operationId }), restored);
    assert.equal((await net.lifecycle()).sessionId, lifecycle.sessionId);
    restores.push({
      branch,
      elapsedMs: restoreMs,
      verificationMs: performance.now() - started - restoreMs,
      ownerAllocatedBytes: await allocatedBytes(store.root),
    });
  }
  await net.close();
  net = await Devnet.fromSnapshot(snapshot, { id });
  assert.equal((await net.status()).now, saved.now);
  assert.deepEqual(await net.beacon("/eth/v2/beacon/blocks/head"), block);
  await checkSavedState();
  const removalId = crypto.randomUUID();
  const removalStarted = performance.now();
  assert.deepEqual(await net.removeSnapshot(snapshot, { operationId: removalId }), snapshot);
  const removalMs = performance.now() - removalStarted;
  assert.deepEqual(await net.listSnapshots(), []);
  assert.deepEqual(await net.removeSnapshot(snapshot, { operationId: removalId }), snapshot);
  await assert.rejects(net.restoreSnapshot(snapshot), /removed/);
  assert.equal((await net.lifecycle()).ready, true);
  const diskAfterRemoval = await allocatedBytes(store.root);
  const nextTransaction = await send();
  assert.equal(Number(BigInt(nextTransaction.receipt.blockNumber)), saved.slot + 1);
  const nextBlock = await net.beacon<{
    data: {
      message: {
        body: {
          payload_attestations: { aggregation_bits: string; data: { payload_present: boolean } }[];
        };
      };
    };
  }>("/eth/v2/beacon/blocks/head");
  assert(
    nextBlock.data.message.body.payload_attestations.some((vote) =>
      vote.data.payload_present && BigInt(vote.aggregation_bits) > 0n
    ),
  );
  await net.advanceUntil(
    async () => BigInt((await net!.status()).finality.data.finalized.epoch) >= 2n,
    { maxSlots: 160, timeoutMs: 180_000 },
  );
  const final = await net.status();
  const execution = await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false]);
  assert.equal(execution.hash, await finalizedExecutionHash(await Network.manifest(id)));
  await profileReport(final, "snapshots", {
    passed: true,
    captureMs,
    snapshotBytes,
    disk: {
      basis:
        "du -sk filesystem-reported allocated bytes; whole owner includes data, archives, journals and logs",
      beforeCapture: diskBeforeCapture,
      afterCapture: diskAfterCapture,
      additionalAfterCapture: diskAfterCapture - diskBeforeCapture,
      archiveAllocatedBytes,
      afterRemoval: diskAfterRemoval,
      transientPeakMeasured: false,
      note:
        "Measurements are retained usage at each cut; shared filesystem extents may be counted per file",
    },
    independentState: {
      storage,
      includedTransaction: included.hash,
      beaconSszBytes: state.length,
      beaconSszSha256: await sha256(state),
      checks: ["source resume", "live restore", "repeated restore", "crashed beacon", "offline"],
    },
    restores,
    removalMs,
    firstTransactionMs: nextTransaction.elapsedMs,
    finalSlot: final.slot,
    finalizedEpoch: final.finality.data.finalized.epoch,
    schema: archive.schema,
    checkpointAbi: archive.checkpoint.abi,
    images: archive.images,
    elapsedMs: performance.now() - started,
  });
  passed = true;
} finally {
  await net?.close();
  if (passed) {
    await store.snapshotsDirectory();
    assert.equal(await store.active(), undefined);
    await Deno.remove(store.root, { recursive: true });
  }
}
