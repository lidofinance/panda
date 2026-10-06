/** Public snapshot lifecycle against the selected real EL/CL bake. */
import assert from "node:assert/strict";
import { toBeHex, type TransactionRequest, Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { Controller } from "../../../src/controller.ts";
import { finalizedExecutionHash } from "../../../src/consensus.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { json } from "../../../src/http.ts";
import { sha256 } from "../../../src/profiles.ts";
import { SnapshotStore } from "../../../src/snapshots.ts";
import { StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { assertFullBitvector } from "../../shared/tests/warp_assertions.ts";

export async function snapshotTransaction(net: Devnet, transaction: TransactionRequest = {}) {
  const raw = await new Wallet(privateKey).signTransaction({
    type: 2,
    chainId: 1337,
    nonce: Number(BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "latest"]))),
    to: account,
    value: 1n,
    gasLimit: 21_000,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...transaction,
  });
  await net.setAutomine(true);
  const hash = await net.rpc<string>("eth_sendRawTransaction", [raw]);
  const receipt = await net.waitForService(
    "snapshot branch transaction",
    async () =>
      await net.rpc<
        {
          status: string;
          blockNumber: string;
          contractAddress: string | null;
        } | null
      >("eth_getTransactionReceipt", [hash]) ?? undefined,
    120_000,
  );
  await net.setAutomine(false);
  assert.equal(receipt.status, "0x1");
  return { hash, receipt };
}

/** Writes a 32-byte call into slot 0; an empty call returns slot 0. */
export const snapshotContract = {
  runtime: "0x3615600c57600035600055005b60005460005260206000f3",
  deploy: "0x6018600c60003960186000f33615600c57600035600055005b60005460005260206000f3",
};

/** The restored contract must still exist, read its storage and execute a new write. */
export async function assertContractWorks(net: Devnet, contract: string, stored: bigint) {
  assert.equal(await net.rpc("eth_getCode", [contract, "latest"]), snapshotContract.runtime);
  const read = async () =>
    BigInt(await net.rpc<string>("eth_call", [{ to: contract, data: "0x" }, "latest"]));
  assert.equal(await read(), stored, "restored contract returned a different value");
  const written = stored + 1000n;
  const call = await snapshotTransaction(net, {
    to: contract,
    value: 0n,
    data: toBeHex(written, 32),
    gasLimit: 12_000_000,
  });
  assert.equal(await read(), written, "restored contract did not execute a new write");
  assert.equal(
    BigInt(await net.rpc<string>("eth_getStorageAt", [contract, "0x0", "latest"])),
    written,
  );
  return call;
}

export async function snapshotBeaconState(url: string) {
  const response = await fetch(`${url}/eth/v2/debug/beacon/states/head`, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200, "Beacon state read failed");
  assert.match(response.headers.get("content-type") ?? "", /application\/octet-stream/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 0);
  return bytes;
}

export async function assertSnapshotPtc(net: Devnet, slot: number) {
  const { data: { message } } = await net.beacon<{
    data: {
      message: {
        slot: string;
        parent_root: string;
        body: {
          payload_attestations: {
            aggregation_bits: string;
            data: {
              slot: string;
              beacon_block_root: string;
              payload_present: boolean;
              blob_data_available: boolean;
            };
          }[];
        };
      };
    };
  }>(`/eth/v2/beacon/blocks/${slot}`);
  assert.equal(Number(message.slot), slot);
  let bits = 0n;
  for (const vote of message.body.payload_attestations) {
    assert.equal(Number(vote.data.slot), slot - 1);
    assert.equal(vote.data.beacon_block_root, message.parent_root);
    assert.equal(vote.data.payload_present, true);
    assert.equal(vote.data.blob_data_available, true);
    bits |= BigInt(vote.aggregation_bits);
  }
  assertFullBitvector(`0x${bits.toString(16)}`, 512, `restored block ${slot} PTC`);
}

if (import.meta.main) {
  const id = `snapshots-${crypto.randomUUID().slice(0, 8)}`;
  const started = performance.now();
  const store = new StateStore(id);
  const infra = new Infrastructure(id);
  let controller: Controller | undefined;
  let passed = false;
  try {
    controller = await Controller.start({ id, profile: "gloas" });
    const net = new Devnet(controller.serve(0));
    const beaconUrl = controller.serveClient("beacon");
    const validatorUrl = controller.serveClient("vc");
    const keys = async () => {
      const token = (await Deno.readTextFile(
        `${controller!.manifest.directory}/validator-keys/keys/api-token.txt`,
      )).trim();
      return await json<{ data: { validating_pubkey: string }[] }>(
        `${validatorUrl}/eth/v1/keystores`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
    };
    const deployment = await snapshotTransaction(net, {
      to: null,
      value: 0n,
      gasLimit: 12_000_000,
      data: snapshotContract.deploy,
    });
    const contract = deployment.receipt.contractAddress;
    assert(contract);
    const write = (value: bigint) =>
      snapshotTransaction(net, {
        to: contract,
        value: 0n,
        data: toBeHex(value, 32),
        gasLimit: 12_000_000,
      });
    const included = await write(42n);
    await net.advanceSlots(1);
    const before = await net.status();
    const state = await snapshotBeaconState(beaconUrl);
    const block = await net.beacon("/eth/v2/beacon/blocks/head");
    const validatorKeys = await keys();
    assert.equal(validatorKeys.data.length, 64);
    const balance = await net.rpc("eth_getBalance", [account, "latest"]);
    const nonce = await net.rpc("eth_getTransactionCount", [account, "latest"]);
    const assertSaved = async () => {
      const status = await net.status();
      assert.equal(status.now, before.now);
      assert.equal(status.slot, before.slot);
      assert.deepEqual(status.el, before.el);
      assert.deepEqual(await snapshotBeaconState(beaconUrl), state);
      assert.deepEqual(await net.beacon("/eth/v2/beacon/blocks/head"), block);
      assert.deepEqual(
        await keys(),
        validatorKeys,
        "stable VC frontend did not follow replacement",
      );
      assert.equal(
        BigInt(await net.rpc<string>("eth_getStorageAt", [contract, "0x0", "latest"])),
        42n,
      );
      assert.equal(await net.rpc("eth_getBalance", [account, "latest"]), balance);
      assert.equal(await net.rpc("eth_getTransactionCount", [account, "latest"]), nonce);
      assert.deepEqual(
        await net.rpc("eth_getTransactionReceipt", [included.hash]),
        included.receipt,
      );
    };
    await net.setAutomine(true);
    const createId = crypto.randomUUID();
    const snapshot = await net.createSnapshot(createId);
    assert.equal((await net.status()).automine, true, "create did not restore automine");
    await assertSaved();
    assert.deepEqual(await net.createSnapshot(createId), snapshot, "lost create ACK repeated work");
    assert.deepEqual(await net.listSnapshots(), [snapshot]);
    await net.setAutomine(false);
    const artifact = await new SnapshotStore(store, infra).read(snapshot.id);
    const restores = [];
    for (const value of [77n, 99n]) {
      const branchTransaction = await write(value);
      await net.advanceSlots(1);
      const previous = await net.lifecycle();
      const operation = crypto.randomUUID();
      const began = performance.now();
      const restored = await net.restoreSnapshot(snapshot, operation);
      await assertSaved();
      assert.equal((await net.status()).automine, false);
      assert.equal(await net.rpc("eth_getTransactionReceipt", [branchTransaction.hash]), null);
      assert.notEqual(restored.sessionId, previous.sessionId);
      assert.notEqual(restored.generation, previous.generation);
      assert.deepEqual(
        await net.restoreSnapshot(snapshot, operation),
        restored,
        "lost restore ACK repeated work",
      );
      assert.equal((await net.lifecycle()).sessionId, restored.sessionId);
      const immediate = await net.createSnapshot();
      await net.removeSnapshot(immediate);
      await assertSaved();
      // The first block after restore executes the restored contract, not just a transfer.
      const next = await assertContractWorks(net, contract, 42n);
      assert.equal(Number(BigInt(next.receipt.blockNumber)), Number(BigInt(before.el.number)) + 1);
      await assertSnapshotPtc(net, before.slot + 1);
      await net.advanceSlots(1);
      await assertSnapshotPtc(net, before.slot + 2);
      assert.deepEqual(
        await new SnapshotStore(store, infra).read(snapshot.id),
        artifact,
        "working branch changed immutable snapshot",
      );
      restores.push({ elapsedMs: performance.now() - began });
    }
    await net.advanceUntil(
      async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 2n,
      { maxSlots: 160, timeoutMs: 240_000 },
    );
    // A restored network must survive a sync-committee-period fast warp (VC replacement) and
    // keep executing the restored contract and finalizing afterwards.
    const warpedFrom = await net.status();
    await net.advanceTime(8192 * 12, { mode: "fast" });
    const warped = await net.status();
    assert(warped.slot >= warpedFrom.slot + 8192, "fast warp after restore did not advance");
    await assertContractWorks(
      net,
      contract,
      BigInt(await net.rpc<string>("eth_getStorageAt", [contract, "0x0", "latest"])),
    );
    const warpedFinality = BigInt(warped.finality.data.finalized.epoch);
    await net.advanceUntil(
      async () => BigInt((await net.status()).finality.data.finalized.epoch) > warpedFinality,
      { maxSlots: 160, timeoutMs: 240_000 },
    );
    const final = await net.status();
    const finalized = await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false]);
    assert.equal(finalized.hash, await finalizedExecutionHash(controller.manifest));
    const removeId = crypto.randomUUID();
    assert.deepEqual(await net.removeSnapshot(snapshot, removeId), snapshot);
    assert.deepEqual(await net.removeSnapshot(snapshot, removeId), snapshot);
    assert.deepEqual(await net.listSnapshots(), []);
    await assert.rejects(net.restoreSnapshot(snapshot), /removed/);
    assert.equal((await net.lifecycle()).ready, true, "invalid restore damaged healthy source");
    await net.stepSlot();
    await profileReport(final, "snapshots", {
      passed: true,
      savedSlot: before.slot,
      restores,
      savedSszBytes: state.length,
      savedSszSha256: await sha256(state),
      stableFrontends: ["el", "cl", "vc"],
      restoredContractExecutes: true,
      fastWarpAfterRestore: { from: warpedFrom.slot, to: warped.slot },
      finalizedEpoch: final.finality.data.finalized.epoch,
      elapsedMs: performance.now() - started,
    });
    passed = true;
  } finally {
    await controller?.close();
    assert.equal(
      (await infra.docker.listContainers({ all: true, filters: { label: [`${LABEL}=${id}`] } }))
        .length,
      0,
    );
    if (passed) await Deno.remove(store.root, { recursive: true });
  }
}
