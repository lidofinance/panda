/** Real Geth KZG/PeerDAS data through public snapshots and exact branch replay. */
import assert from "node:assert/strict";
import { decodeRlp, encodeRlp, hexlify, keccak256, sha256, toQuantity, Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { finalizedExecutionHash } from "../../../src/consensus.ts";
import { Controller } from "../../../src/controller.ts";
import { StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import {
  exportSigningHistory,
  retainedSigningHistory,
} from "../../shared/tests/signing_history.ts";
import { assertSigningHistory } from "../../shared/tests/warp_assertions.ts";
import { assertSnapshotPtc, snapshotBeaconState } from "./snapshots.ts";

type Response<T> = { version?: string; execution_optimistic?: boolean; data: T };
type SignedBlock = {
  signature: string;
  message: {
    slot: string;
    state_root: string;
    body: {
      signed_execution_payload_bid: {
        message: { block_hash: string; blob_kzg_commitments: string[] };
      };
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
type Column = {
  index: string;
  slot: string;
  beacon_block_root: string;
  column: string[];
  kzg_proofs: string[];
};
type Receipt = { status: string; blockHash: string; blockNumber: string; blobGasUsed?: string };
type BlobTransaction = {
  raw: string;
  hash: string;
  blob: string;
  commitment: string;
  chainId: number;
};

/** Geth computes real proofs; ethers only signs the EIP-4844 transaction body.
 * Geth 5d8fd6b6 core/types/tx_blob.go encodes its Osaka V1 network wrapper as
 * [transaction, version, blobs, commitments, cell_proofs]. Ethers 6.15 only parses V0.
 */
async function blobTransaction(net: Devnet, chainId: number): Promise<BlobTransaction> {
  const bytes = new Uint8Array(4096 * 32);
  const view = new DataView(bytes.buffer);
  // Distinct small field elements are canonical BLS scalar encodings, not an all-zero fixture.
  for (let i = 0; i < 4096; i++) view.setUint32(i * 32 + 28, i + 1, false);
  const blob = hexlify(bytes);
  const fees = { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  const filled = await net.rpc<{ raw: string }>("eth_fillTransaction", [{
    from: account,
    to: account,
    chainId: toQuantity(chainId),
    nonce: "0x0",
    gas: "0x5208",
    value: "0x1",
    maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}`,
    maxFeePerBlobGas: "0x2540be400",
    blobs: [blob],
  }]);
  assert(filled.raw.startsWith("0x03"), "Geth must construct a type-3 transaction");
  const wrapper = decodeRlp(`0x${filled.raw.slice(4)}`);
  assert(Array.isArray(wrapper) && wrapper.length === 5, "expected Osaka sidecar V1");
  const [unsigned, version, blobs, commitments, proofs] = wrapper;
  assert(Array.isArray(unsigned) && unsigned.length === 14);
  assert.equal(version, "0x01");
  assert.deepEqual(blobs, [blob]);
  assert(Array.isArray(commitments) && commitments.length === 1);
  assert(Array.isArray(proofs) && proofs.length === 128);
  assert.equal(typeof commitments[0], "string");
  const commitment = commitments[0] as string;
  assert.equal(commitment.length, 2 + 48 * 2);
  for (const proof of proofs) assert(typeof proof === "string" && proof.length === 2 + 48 * 2);
  const versionedHash = `0x01${sha256(commitment).slice(4)}`;
  assert.deepEqual(unsigned[10], [versionedHash]);
  const signed = await new Wallet(privateKey).signTransaction({
    type: 3,
    chainId,
    nonce: 0,
    to: account,
    value: 1n,
    gasLimit: 21_000n,
    ...fees,
    maxFeePerBlobGas: 10_000_000_000n,
    blobVersionedHashes: [versionedHash],
  });
  const body = decodeRlp(`0x${signed.slice(4)}`);
  assert(Array.isArray(body));
  assert.deepEqual(
    body.slice(0, 11),
    unsigned.slice(0, 11),
    "sign only Geth's exact prepared body",
  );
  return {
    raw: `0x03${encodeRlp([body, version, blobs, commitments, proofs]).slice(2)}`,
    hash: keccak256(signed),
    blob,
    commitment,
    chainId,
  };
}

async function sszHash(net: Devnet, path: string) {
  const response = await fetch(`${net.url}${path}`, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200, `SSZ response for ${path}`);
  assert.match(response.headers.get("content-type") ?? "", /application\/octet-stream/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 0);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function blobEvidence(net: Devnet, transaction: BlobTransaction) {
  const { data: { root } } = await net.beacon<Response<{ root: string }>>(
    "/eth/v1/beacon/headers/head",
  );
  const block = await net.beacon<Response<SignedBlock>>(`/eth/v2/beacon/blocks/${root}`);
  assert.equal(block.version, "gloas");
  assert.equal(block.execution_optimistic, false);
  const bid = block.data.message.body.signed_execution_payload_bid.message;
  assert.deepEqual(bid.blob_kzg_commitments, [transaction.commitment]);
  const columnsPath = `/eth/v1/debug/beacon/data_column_sidecars/${root}`;
  const columns = await net.beacon<Response<Column[]>>(columnsPath);
  assert.equal(columns.execution_optimistic, false);
  assert.equal(columns.data.length, 128, "supernode must retain every verified custody column");
  assert.deepEqual(
    columns.data.map((column) => Number(column.index)).sort((a, b) => a - b),
    Array.from({ length: 128 }, (_, i) => i),
  );
  for (const column of columns.data) {
    assert.equal(column.beacon_block_root, root);
    assert.equal(column.slot, block.data.message.slot);
    assert.equal(column.column.length, 1);
    assert.equal(column.column[0].length, 2 + 2048 * 2);
    assert.equal(column.kzg_proofs.length, 1);
    assert.equal(column.kzg_proofs[0].length, 2 + 48 * 2);
  }
  // Raw blob reconstruction verifies actual persisted data, not just matching commitments.
  const blobs = await net.beacon<Response<string[]>>(`/eth/v1/beacon/blobs/${root}`);
  assert.deepEqual(blobs.data, [transaction.blob]);
  const envelopePath = `/eth/v1/beacon/execution_payload_envelopes/${root}`;
  const envelope = await net.beacon<
    Response<{
      message: {
        beacon_block_root: string;
        payload: { block_hash: string; transactions: string[] };
      };
    }>
  >(envelopePath);
  assert.equal(envelope.execution_optimistic, false);
  assert.equal(envelope.data.message.beacon_block_root, root);
  assert.equal(envelope.data.message.payload.block_hash, bid.block_hash);
  assert(
    envelope.data.message.payload.transactions.some((raw) => keccak256(raw) === transaction.hash),
  );
  const receipt = await net.rpc<Receipt | null>("eth_getTransactionReceipt", [transaction.hash]);
  assert(receipt);
  assert.equal(receipt.status, "0x1");
  assert.equal(receipt.blobGasUsed, "0x20000");
  assert.equal(receipt.blockHash, bid.block_hash);
  return {
    root,
    block: block.data,
    receipt,
    columns: await sszHash(net, columnsPath),
    envelope: await sszHash(net, envelopePath),
  };
}

export async function runSnapshotBlobs() {
  if (!Deno.env.has("PANDA_TIMEOUT_MS")) Deno.env.set("PANDA_TIMEOUT_MS", "60000");
  const started = performance.now();
  const id = `snapshot-blobs-${crypto.randomUUID().slice(0, 8)}`;
  const store = new StateStore(id);
  const controller = await Controller.start({ id, profile: "gloas" });
  const net = new Devnet(controller.serve(0));
  let passed = false;
  try {
    await net.advanceSlots(3);
    const transaction = await blobTransaction(net, controller.manifest.config.chainId);
    assert.equal(await net.rpc("eth_sendRawTransaction", [transaction.raw]), transaction.hash);
    await net.stepSlot();
    const saved = await net.status();
    assert.equal(saved.slot, 4);
    const before = await blobEvidence(net, transaction);
    const state = await snapshotBeaconState(net.url);
    const history = await exportSigningHistory(controller.manifest);
    const snapshot = await net.createSnapshot();
    assert.equal(snapshot.headSlot, 4);
    assert.equal(snapshot.nowMs, saved.now * 1000);
    assert.equal(snapshot.headBlockRoot, before.root);
    const nextTx = await new Wallet(privateKey).signTransaction({
      type: 2,
      chainId: transaction.chainId,
      nonce: 1,
      to: account,
      value: 2n,
      gasLimit: 21_000n,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const continueBranch = async () => {
      const hash = await net.rpc<string>("eth_sendRawTransaction", [nextTx]);
      await net.stepSlot();
      const next = await net.beacon<Response<SignedBlock>>("/eth/v2/beacon/blocks/head");
      assert.equal(next.data.message.slot, "5");
      await assertSnapshotPtc(net, 5);
      for (const vote of next.data.message.body.payload_attestations) {
        assert.equal(vote.data.beacon_block_root, before.root);
      }
      const receipt = await net.rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
      assert(receipt);
      assert.equal(receipt.status, "0x1");
      assert.equal(
        receipt.blockHash,
        next.data.message.body.signed_execution_payload_bid.message.block_hash,
      );
      const nextState = sha256(await snapshotBeaconState(net.url));
      // Epoch 4 finalizes epoch 2, which includes the saved blob slot.
      await net.advanceSlots(128);
      const final = await net.status();
      assert(Number(final.finality.data.finalized.epoch) >= 2);
      const finalized = await finalizedExecutionHash(controller.manifest);
      assert.equal(
        (await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false])).hash,
        finalized,
      );
      const signing = await exportSigningHistory(controller.manifest);
      assertSigningHistory(signing, history, 4);
      return {
        next: next.data,
        receipt,
        nextState,
        finalBlock: await net.beacon("/eth/v2/beacon/blocks/head"),
        finalState: sha256(await snapshotBeaconState(net.url)),
        finalized,
        history: retainedSigningHistory(signing, final.slot),
      };
    };
    // The first branch runs continuously from the saved point. Restore must reproduce it exactly.
    const uninterrupted = await continueBranch();
    await net.restoreSnapshot(snapshot);
    const restored = await net.status();
    assert.equal(restored.now, saved.now);
    assert.equal(restored.slot, saved.slot);
    assert.deepEqual(restored.el, saved.el);
    assert.deepEqual(await snapshotBeaconState(net.url), state);
    assert.deepEqual(
      await blobEvidence(net, transaction),
      before,
      "restore changed blob block, raw data, receipt, envelope or custody-column bytes",
    );
    assert.deepEqual(
      await exportSigningHistory(controller.manifest),
      retainedSigningHistory(history, 4),
    );
    const continued = await continueBranch();
    assert.deepEqual(
      continued,
      uninterrupted,
      "blob restore diverged from uninterrupted execution",
    );
    await profileReport(saved, "snapshot-blobs", {
      passed: true,
      elapsedMs: performance.now() - started,
      savedSlot: saved.slot,
      transaction: transaction.hash,
      blockRoot: before.root,
      savedStateSha256: sha256(state),
      columns: { count: 128, ...before.columns },
      envelope: before.envelope,
      nextStateSha256: continued.nextState,
      finalStateSha256: continued.finalState,
      finalizedExecution: continued.finalized,
      coverage:
        "Geth KZG, verified custody columns and raw blob, exact snapshot restore and branch replay",
    });
    passed = true;
  } finally {
    await controller.close();
    if (passed) {
      assert.equal(await store.active(), undefined);
      await Deno.remove(store.root, { recursive: true });
    }
  }
}

if (import.meta.main) await runSnapshotBlobs();
