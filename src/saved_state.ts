import type { ConsensusMessages } from "./consensus_messages.ts";
import type { ClockState } from "./consensus.ts";
import { json, rpc } from "./http.ts";
import type { Manifest } from "./network.ts";
import type { CapturedState } from "./snapshot_types.ts";

const zero = `0x${"00".repeat(32)}`;

/** Public writes must be captured, synchronously persisted, or known to be read-only. */
export function snapshotRequestSupported(
  target: "el" | "beacon" | "vc",
  method: string,
  path: string,
): boolean {
  if (method === "GET" || method === "HEAD" || target === "el") return true;
  if (target === "vc" || method !== "POST") return false;
  return /^\/eth\/v1\/beacon\/pool\/(payload_attestations|sync_committees|voluntary_exits|proposer_slashings|bls_to_execution_changes)$/
    .test(path) ||
    path === "/eth/v2/beacon/pool/attestations" ||
    /^\/eth\/v[12]\/beacon\/pool\/attester_slashings$/.test(path) ||
    /^\/eth\/v1\/beacon\/states\/[^/]+\/(validators|validator_identities|validator_balances)$/.test(
      path,
    ) ||
    /^\/eth\/v1\/beacon\/rewards\/(attestations|sync_committee)\/[^/]+$/.test(path) ||
    /^\/eth\/v1\/validator\/duties\/(attester|sync|ptc)\/\d+$/.test(path) ||
    /^\/eth\/v1\/validator\/liveness\/\d+$/.test(path);
}

type Beacon<T> = { execution_optimistic: boolean; data: T };
type Header = Beacon<{
  canonical: boolean;
  root: string;
  header: { message: { slot: string; state_root: string } };
}>;
type Block = Beacon<{
  message: {
    slot: string;
    body: {
      signed_execution_payload_bid: { message: { block_hash: string; parent_block_hash: string } };
    };
  };
}>;

function integer(value: string, name: string): number {
  if (!/^(?:0x[0-9a-f]+|\d+)$/.test(value)) throw new Error(`Invalid ${name}`);
  const result = Number(BigInt(value));
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid ${name}`);
  return result;
}

function hash(value: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error("Invalid saved-state root");
  return value;
}

function verified<T>(value: Beacon<T>): T {
  if (value.execution_optimistic !== false) {
    throw new Error("Unverified or optimistic consensus state");
  }
  return value.data;
}

function completedSlot(manifest: Manifest, nowMs: number): number {
  if (
    manifest.config.profile !== "gloas" || manifest.config.mode !== "controlled" ||
    manifest.bake.recipe.ptcReadiness !== true
  ) {
    throw new Error("Snapshots require the controlled Gloas bake with PTC readiness");
  }
  const elapsed = nowMs - manifest.config.genesisTime * 1000;
  if (
    !Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed % 12_000 !== 11_500
  ) {
    throw new Error("Snapshot requires a completed slot tail; time was not advanced");
  }
  return Math.floor(elapsed / 12_000);
}

/** Read persisted chain anchors. The caller closes and drains mutation ingress first. */
async function anchors(
  manifest: Manifest,
  nowMs: number,
): Promise<Omit<CapturedState, "replayMessages">> {
  const slot = completedSlot(manifest, nowMs);
  const beacon = <T>(path: string) => json<T>(`${manifest.beacon}${path}`);
  const header = verified(await beacon<Header>("/eth/v1/beacon/headers/head"));
  if (header.canonical !== true) throw new Error("Snapshot head is not canonical");
  const headSlot = integer(header.header.message.slot, "head slot");
  if (headSlot > slot) throw new Error("Snapshot head is ahead of the saved clock");
  const headBlockRoot = hash(header.root);
  const block = verified(await beacon<Block>(`/eth/v2/beacon/blocks/${headBlockRoot}`));
  if (integer(block.message.slot, "block slot") !== headSlot) {
    throw new Error("Head/block mismatch");
  }
  const bid = block.message.body.signed_execution_payload_bid.message;
  const el = await rpc<{ hash: string; number: string; timestamp: string }>(
    manifest.el,
    "eth_getBlockByNumber",
    ["latest", false],
  );
  const executionBlockHash = hash(el.hash);
  const executionBlockNumber = integer(el.number, "execution block number");
  const timestamp = integer(el.timestamp, "execution timestamp");
  if (timestamp !== manifest.config.genesisTime + headSlot * 12) {
    throw new Error("Execution timestamp does not match the Beacon head");
  }
  if (headSlot === 0) {
    // Gloas genesis has no envelope; its empty bid names the EL genesis as its parent.
    if (
      executionBlockNumber !== 0 || bid.block_hash !== zero || bid.parent_block_hash !== el.hash
    ) {
      throw new Error("Genesis EL/CL disagreement");
    }
  } else {
    const envelope = verified(
      await beacon<
        Beacon<{
          message: { payload: { slot_number: string; block_hash: string; timestamp: string } };
        }>
      >(`/eth/v1/beacon/execution_payload_envelopes/${headBlockRoot}`),
    ).message.payload;
    if (
      integer(envelope.slot_number, "envelope slot") !== headSlot ||
      envelope.block_hash !== bid.block_hash || envelope.block_hash !== el.hash ||
      integer(envelope.timestamp, "envelope timestamp") !== timestamp
    ) {
      throw new Error("Incomplete Gloas envelope or EL/CL disagreement");
    }
  }
  const headStateRoot = hash(
    verified(
      await beacon<Beacon<{ root: string }>>(
        "/eth/v1/beacon/states/head/root",
      ),
    ).root,
  );
  const finality = verified(
    await beacon<Beacon<{ finalized: { epoch: string; root: string } }>>(
      "/eth/v1/beacon/states/head/finality_checkpoints",
    ),
  ).finalized;
  const finalizedEpoch = integer(finality.epoch, "finalized epoch");
  const finalizedRoot = hash(finality.root);
  if (finalizedEpoch > 0) {
    const finalizedBlock = verified(await beacon<Block>(`/eth/v2/beacon/blocks/${finalizedRoot}`));
    const finalized = await rpc<{ hash: string }>(manifest.el, "eth_getBlockByNumber", [
      "finalized",
      false,
    ]);
    if (
      finalized?.hash !==
        finalizedBlock.message.body.signed_execution_payload_bid.message.parent_block_hash
    ) {
      throw new Error("Finalized EL/CL disagreement");
    }
  }
  const pool = await rpc<{ pending: string; queued: string }>(manifest.el, "txpool_status");
  if (
    integer(pool.pending, "pending transactions") || integer(pool.queued, "queued transactions")
  ) {
    throw new Error("Snapshot blocked by pending or queued execution transactions");
  }
  const syncing =
    (await beacon<{ data: { is_syncing: boolean; is_optimistic: boolean; el_offline: boolean } }>(
      "/eth/v1/node/syncing",
    )).data;
  if (
    syncing.is_syncing !== false || syncing.is_optimistic !== false || syncing.el_offline !== false
  ) {
    throw new Error(
      "Snapshot requires a synced, verified Beacon node with its execution client online",
    );
  }
  const after = verified(await beacon<Header>("/eth/v1/beacon/headers/head"));
  const clock = await json<ClockState>(manifest.bnClock);
  if (after.root !== header.root || after.canonical !== true || clock.nowMs !== nowMs) {
    throw new Error("Snapshot anchors or clock changed while reading");
  }
  return {
    schema: 2,
    nowMs,
    slot,
    headSlot,
    headBlockRoot,
    headStateRoot,
    executionBlockHash,
    executionBlockNumber,
    finalizedEpoch,
    finalizedRoot,
  };
}

/** Read-only preflight. No client stop or protocol-time movement happens here. */
export async function captureSavedState(
  manifest: Manifest,
  nowMs: number,
  messages: ConsensusMessages,
): Promise<CapturedState> {
  completedSlot(manifest, nowMs);
  const replayMessages = messages.snapshot();
  const bn = await json<ClockState>(manifest.bnClock);
  const vc = await json<ClockState>(manifest.vcClock);
  if (bn.nowMs !== nowMs || vc.nowMs !== nowMs) throw new Error("Snapshot BN/VC clock mismatch");
  return { ...await anchors(manifest, nowMs), replayMessages };
}

/** Validate a candidate after message replay, with the validator client still absent. */
export async function validateSavedState(manifest: Manifest, saved: CapturedState): Promise<void> {
  const current = await anchors(manifest, saved.nowMs);
  for (const key of Object.keys(current) as (keyof typeof current)[]) {
    if (saved[key] !== current[key]) throw new Error(`Saved-state ${key} mismatch`);
  }
}
