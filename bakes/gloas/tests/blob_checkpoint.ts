/** Real Geth KZG/PeerDAS data across a cold checkpoint, against an uninterrupted reference.
 * Run independently: PANDA_BAKE=<tag> deno run -A bakes/gloas/tests/blob_checkpoint.ts
 * This covers locally built, verified and persisted columns. Peer-driven partial-column
 * reconstruction is a separate native scenario; GET beacon/blobs only reconstructs blob bytes.
 */
import assert from "node:assert/strict";
import { decodeRlp, encodeRlp, hexlify, keccak256, sha256, toQuantity, Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { finalizedExecutionHash } from "../../../src/consensus.ts";
import { Controller } from "../../../src/controller.ts";
import { LABEL, ROLE } from "../../../src/docker.ts";
import { profileReport } from "../../shared/tests/report.ts";
import {
  exportSigningHistory,
  retainedSigningHistory,
} from "../../shared/tests/signing_history.ts";
import { assertFullBitvector, assertSigningHistory } from "../../shared/tests/warp_assertions.ts";

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

async function ssz(net: Devnet, path: string): Promise<Uint8Array> {
  const response = await fetch(`${net.beaconUrl}${path}`, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status !== 200) {
    assert.fail(`${path}: HTTP ${response.status}: ${await response.text()}`);
  }
  assert.match(response.headers.get("content-type") ?? "", /application\/octet-stream/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 0, `empty SSZ response for ${path}`);
  return bytes;
}

async function blobEvidence(net: Devnet, transaction: BlobTransaction, fixturePath?: string) {
  const header = await net.beacon<Response<{ root: string }>>("/eth/v1/beacon/headers/head");
  const root = header.data.root;
  const block = await net.beacon<Response<SignedBlock>>(`/eth/v2/beacon/blocks/${root}`);
  assert.equal(block.version, "gloas");
  assert.equal(block.execution_optimistic, false);
  assert.deepEqual(
    block.data.message.body.signed_execution_payload_bid.message.blob_kzg_commitments,
    [
      transaction.commitment,
    ],
  );
  const columnsPath = `/eth/v1/debug/beacon/data_column_sidecars/${root}`;
  const columns = await net.beacon<Response<Column[]>>(columnsPath);
  assert.equal(columns.execution_optimistic, false);
  assert.equal(columns.data.length, 128, "supernode must retain every verified custody column");
  assert.deepEqual(
    columns.data.map((c) => Number(c.index)).sort((a, b) => a - b),
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
  // The pinned BlobWrapper has serde(transparent): JSON contains hex strings.
  const blobs = await net.beacon<Response<string[]>>(`/eth/v1/beacon/blobs/${root}`);
  assert.deepEqual(
    blobs.data,
    [transaction.blob],
    "columns must reconstruct the input blob",
  );
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
  assert.equal(
    envelope.data.message.payload.block_hash,
    block.data.message.body.signed_execution_payload_bid.message.block_hash,
  );
  assert(
    envelope.data.message.payload.transactions.some((raw) => keccak256(raw) === transaction.hash),
  );
  const receipt = await net.rpc<Receipt | null>("eth_getTransactionReceipt", [transaction.hash]);
  assert(receipt, "blob transaction must be canonical before checkpoint");
  assert.equal(receipt.status, "0x1");
  assert.equal(receipt.blobGasUsed, "0x20000");
  assert.equal(receipt.blockHash, envelope.data.message.payload.block_hash);
  if (fixturePath) {
    await Deno.mkdir(".cache/p3", { recursive: true });
    await Deno.writeTextFile(
      fixturePath,
      JSON.stringify({
        blockSsz: hexlify(await ssz(net, `/eth/v2/beacon/blocks/${root}`)),
        columns: columns.data,
      }),
    );
  }
  return {
    root,
    block: block.data,
    receipt,
    columns: await ssz(net, columnsPath),
    envelope: await ssz(net, envelopePath),
  };
}

async function sample(restart: boolean, input?: BlobTransaction) {
  const c = await Controller.start({
    profile: "gloas",
    id: `blob-${crypto.randomUUID().slice(0, 8)}`,
  });
  const net = new Devnet(c.serve(0));
  try {
    assert.equal(c.manifest.bake.recipe.checkpointAbi, 1);
    await net.advanceSlots(3);
    const transaction = input ?? await blobTransaction(net, c.manifest.config.chainId);
    assert.equal(transaction.chainId, c.manifest.config.chainId);
    assert.equal(await net.rpc("eth_sendRawTransaction", [transaction.raw]), transaction.hash);
    await net.stepSlot();
    const before = await blobEvidence(
      net,
      transaction,
      restart ? undefined : `.cache/p3/blob-checkpoint-${c.manifest.bake.tag}.json`,
    );
    const clock = c.time.nowMs;
    const history = await exportSigningHistory(c.manifest);
    if (restart) {
      const generation = c.network.generation!.generation;
      const clients = await c.network.infra.docker.listContainers({
        filters: { label: [`${LABEL}=${c.manifest.config.id}`] },
      });
      const ids = clients.filter((v) => ["el", "bn", "vc"].includes(v.Labels[ROLE])).map((v) =>
        v.Id
      );
      assert.equal(ids.length, 3);
      const checkpoint = await net.stop();
      assert.equal(checkpoint.nowMs, clock);
      assert.equal(checkpoint.headBlockRoot, before.root);
      assert.equal(checkpoint.headStateRoot, before.block.message.state_root);
      assert.equal(checkpoint.headSlot, 4);
      // Lighthouse's completed-tail fork-choice tick has prepared the next slot;
      // the head and exact protocol clock still belong to slot 4.
      assert.equal(checkpoint.forkChoiceSlot, 5);
      await net.resume();
      assert.equal(c.network.generation!.generation, generation, "resume must retain the same DBs");
      const restarted = await c.network.infra.docker.listContainers({
        filters: { label: [`${LABEL}=${c.manifest.config.id}`] },
      });
      assert(!restarted.some((v) => ids.includes(v.Id)), "resume must start new client processes");
      assert.equal(c.time.nowMs, clock, "cold resume must not advance protocol time");
      assert.deepEqual(
        await blobEvidence(net, transaction),
        before,
        "cold resume changed blob block, receipt, envelope or custody-column bytes",
      );
      assert.deepEqual(await exportSigningHistory(c.manifest), retainedSigningHistory(history, 4));
    }
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
    const nextHash = await net.rpc<string>("eth_sendRawTransaction", [nextTx]);
    await net.stepSlot();
    const next = await net.beacon<Response<SignedBlock>>("/eth/v2/beacon/blocks/head");
    assert.equal(next.data.message.slot, "5");
    const votes = next.data.message.body.payload_attestations;
    assert(votes.length > 0, "next block must include the saved blob payload's real PTC votes");
    let mask = 0n;
    for (const vote of votes) {
      assert.equal(vote.data.slot, "4");
      assert.equal(vote.data.beacon_block_root, before.root);
      assert(vote.data.payload_present && vote.data.blob_data_available);
      mask |= BigInt(vote.aggregation_bits);
    }
    assertFullBitvector(`0x${mask.toString(16)}`, 512, "blob PTC after checkpoint");
    const nextReceipt = await net.rpc<Receipt | null>("eth_getTransactionReceipt", [nextHash]);
    assert(nextReceipt);
    assert.equal(nextReceipt.status, "0x1");
    assert.equal(
      nextReceipt.blockHash,
      next.data.message.body.signed_execution_payload_bid.message.block_hash,
    );
    // Ordinary FFG finality trails the current epoch by two: slot 133 is in
    // epoch 4, so finalized epoch 2 also proves the slot-4 blob is finalized.
    await net.advanceSlots(128);
    const status = await net.status();
    assert(Number(status.finality.data.finalized.epoch) >= 2);
    const finalized = await finalizedExecutionHash(c.manifest);
    assert.equal(
      (await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false])).hash,
      finalized,
    );
    const finalHistory = await exportSigningHistory(c.manifest);
    assertSigningHistory(finalHistory, history, 4);
    const final = await net.beacon<Response<SignedBlock>>("/eth/v2/beacon/blocks/head");
    return {
      transaction,
      profile: c.manifest.config.profile,
      bake: c.manifest.bake.tag,
      bakeKey: c.manifest.bake.key,
      evidence: {
        before,
        next: next.data,
        nextReceipt,
        final: final.data,
        finalized,
        history: retainedSigningHistory(finalHistory, status.slot),
      },
    };
  } finally {
    await net.close();
    await c.close();
  }
}

export async function runBlobCheckpoint() {
  if (!Deno.env.has("PANDA_TIMEOUT_MS")) Deno.env.set("PANDA_TIMEOUT_MS", "60000");
  const started = performance.now();
  const reference = await sample(false);
  const resumed = await sample(true, reference.transaction);
  assert.equal(resumed.bakeKey, reference.bakeKey);
  assert.deepEqual(
    resumed.evidence,
    reference.evidence,
    "blob checkpoint diverged from uninterrupted execution",
  );
  const before = resumed.evidence.before;
  await profileReport(resumed, "blob-checkpoint", {
    passed: true,
    elapsedMs: performance.now() - started,
    transaction: reference.transaction.hash,
    blockRoot: before.root,
    stateRoot: before.block.message.state_root,
    columns: { count: 128, bytes: before.columns.length, sha256: sha256(before.columns) },
    envelope: { bytes: before.envelope.length, sha256: sha256(before.envelope) },
    continuationStateRoot: resumed.evidence.next.message.state_root,
    finalStateRoot: resumed.evidence.final.message.state_root,
    finalizedExecution: resumed.evidence.finalized,
    coverage:
      "Geth KZG, self-built verified DA, cold persistent resume, exact reference continuation",
  });
}

if (import.meta.main) await runBlobCheckpoint();
