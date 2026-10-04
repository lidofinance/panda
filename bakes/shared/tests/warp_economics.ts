import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { privateKey } from "../../../src/config.ts";
import { finalizedExecutionHash } from "../../../src/consensus.ts";
import { delay, json } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { profileReport } from "./report.ts";
import {
  assertFullBitvector,
  assertFullParticipation,
  assertNoAttestationPenalties,
  type AttestationReward,
} from "./warp_assertions.ts";

// W03/W04/W07 regression: steady healthy genesis keys, no injected deposits/exits or missing signers.
// Reward deltas are checked directly; a legitimate automatic withdrawal is not a penalty.
await using net = await Devnet.start({ id: `economics-${crypto.randomUUID().slice(0, 8)}` });
const manifest = await Network.manifest((await net.status()).id);
const count = manifest.config.validators;
const wallet = new Wallet(privateKey);
const spec = (await net.beacon<{ data: Record<string, string> }>("/eth/v1/config/spec")).data;
interface State {
  slot: string;
  balances: string[];
  previous_epoch_participation: string[];
  inactivity_scores: string[];
  validators: { slashed: boolean }[];
}
const state = async () => {
  const result = await json<{ execution_optimistic: boolean; data: State }>(
    `${net.beaconUrl}/eth/v2/debug/beacon/states/head`,
    { headers: { accept: "application/json" } },
  );
  assert.equal(result.execution_optimistic, false);
  return result.data;
};
await net.advanceSlots(128);
const before = await net.status();
const initial = await state();
assertFullParticipation(initial.previous_epoch_participation, initial.inactivity_scores, count);
assert(Number(before.finality.data.finalized.epoch) >= 2, "Fixture must already be finalized");

const samples = [];
const failures: string[] = [];
for (const method of ["advanceTime", "advanceTo"] as const) {
  const start = await net.status();
  const slots = 96;
  const target = start.now + slots * 12;
  const clock = performance.now();
  if (method === "advanceTime") await net.advanceTime(slots * 12);
  else await net.advanceTo(target);
  const elapsedMs = performance.now() - clock;
  const end = await net.status();
  const after = await state();
  const epoch = Math.floor(end.slot / 32);
  const rewards: { epoch: number; data: { total_rewards: AttestationReward[] } }[] = [];
  for (let e = Math.floor(start.slot / 32); e <= epoch - 2; e++) {
    const response = await json<{ data: { total_rewards: AttestationReward[] } }>(
      `${net.beaconUrl}/eth/v1/beacon/rewards/attestations/${e}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "[]" },
    );
    rewards.push({ epoch: e, data: { total_rewards: response.data.total_rewards } });
  }
  const check = (name: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      failures.push(`${method}: ${name}: ${String(error)}`);
    }
  };
  check("exact time", () => assert.equal(end.now, target));
  check("complete block history", () =>
    assert.equal(
      BigInt(end.el.number) - BigInt(start.el.number),
      BigInt(slots),
      "Warp skipped proposals",
    ));
  check("participation", () =>
    assertFullParticipation(
      after.previous_epoch_participation,
      after.inactivity_scores,
      count,
    ));
  check("no slashing", () => assert(after.validators.every((v) => !v.slashed)));
  const blocks = [];
  for (let slot = start.slot + 1; slot <= end.slot; slot++) {
    const block = await net.beacon<{
      execution_optimistic: boolean;
      data: {
        message: {
          slot: string;
          parent_root: string;
          state_root: string;
          body: {
            sync_aggregate: { sync_committee_bits: string };
            payload_attestations?: {
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
    const message = block.data.message;
    check(`slot ${slot} duties`, () => {
      assert.equal(block.execution_optimistic, false);
      assert.equal(Number(message.slot), slot);
      assertFullBitvector(
        message.body.sync_aggregate.sync_committee_bits,
        Number(spec.SYNC_COMMITTEE_SIZE),
        "sync",
      );
      if (manifest.config.profile === "gloas") {
        let mask = 0n;
        for (const vote of message.body.payload_attestations ?? []) {
          assert.equal(Number(vote.data.slot), slot - 1);
          assert.equal(vote.data.beacon_block_root, message.parent_root);
          assert(vote.data.payload_present && vote.data.blob_data_available);
          mask |= BigInt(vote.aggregation_bits);
        }
        assertFullBitvector(`0x${mask.toString(16)}`, Number(spec.PTC_SIZE), "PTC");
      }
    });
    blocks.push({ slot, stateRoot: message.state_root });
  }
  for (const reward of rewards) {
    check(
      `epoch ${reward.epoch} economy`,
      () => assertNoAttestationPenalties(reward.data.total_rewards, count),
    );
  }
  check("finality at return", () =>
    assert(
      Number(end.finality.data.finalized.epoch) >= epoch - 2,
      "Warp returned before normal finality; no recovery slots are allowed",
    ));
  const finalized = await finalizedExecutionHash(manifest);
  const elFinalized = await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false]);
  check("finalized execution agreement", () => assert.equal(elFinalized.hash, finalized));
  const nextTransactionStart = performance.now();
  await net.setAutomine(true);
  const nonce = Number(
    BigInt(await net.rpc<string>("eth_getTransactionCount", [wallet.address, "latest"])),
  );
  const signed = await wallet.signTransaction({
    chainId: manifest.config.chainId,
    nonce,
    type: 2,
    gasLimit: manifest.config.profile === "gloas" ? 12_000_000n : 2_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    data: "0x600060005360016000f3",
  });
  const hash = await net.rpc<string>("eth_sendRawTransaction", [signed]);
  const receipt = await net.waitForService(
    "deployment after honest warp",
    async () =>
      (await net.rpc<{ status: string; blockHash: string; contractAddress: string } | null>(
        "eth_getTransactionReceipt",
        [hash],
      )) ?? undefined,
    10_000,
  );
  await net.setAutomine(false);
  check("next deployment succeeded", () => assert.equal(receipt.status, "0x1"));
  const code = await net.rpc("eth_getCode", [receipt.contractAddress, "latest"]);
  check("deployed runtime", () => assert.equal(code, "0x00"));
  const deployed = await net.status();
  assert.equal(deployed.slot, end.slot + 1);
  assert.equal(deployed.el.hash, receipt.blockHash);
  const nextTransactionMs = performance.now() - nextTransactionStart;
  samples.push({
    method,
    elapsedMs,
    start,
    end,
    participation: after.previous_epoch_participation,
    inactivity: after.inactivity_scores,
    balances: after.balances,
    rewards,
    blocks,
    nextTransactionMs,
    warpAndNextTransactionMs: elapsedMs + nextTransactionMs,
    receipt,
  });
}
let failureSafety: { removedIndex: string; elapsedMs: number; stoppedSlot: number } | undefined;
if (manifest.bake.recipe.directSync) {
  const beforeFailure = await net.status();
  const nextSlot = beforeFailure.slot + 1;
  const duties = await net.beacon<{ data: { slot: string; validator_index: string }[] }>(
    `/eth/v1/validator/duties/proposer/${Math.floor(nextSlot / 32)}`,
  );
  const proposer = duties.data.find((duty) => Number(duty.slot) === nextSlot);
  assert(proposer, "missing next proposer duty");
  const committee = await net.beacon<{ data: { validators: string[] } }>(
    "/eth/v1/beacon/states/head/sync_committees",
  );
  const removedIndex = committee.data.validators.find((index) =>
    index !== proposer.validator_index
  );
  assert(removedIndex, "fixture requires a sync participant other than the next proposer");
  const record = await net.beacon<{ data: { validator: { pubkey: string } } }>(
    `/eth/v1/beacon/states/head/validators/${removedIndex}`,
  );
  const token = (await Deno.readTextFile(`${manifest.directory}/validator-keys/keys/api-token.txt`))
    .trim();
  const deleted = await json<{ data: { status: string }[] }>(
    `${net.validatorUrl}/eth/v1/keystores`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ pubkeys: [record.data.validator.pubkey] }),
    },
  );
  assert.equal(deleted.data[0]?.status, "deleted");
  const started = performance.now();
  const previousTimeout = Deno.env.get("PANDA_TIMEOUT_MS");
  try {
    // Deliberately broken signer: verify a strict failure budget independently of runtime defaults.
    Deno.env.set("PANDA_TIMEOUT_MS", "30000");
    await assert.rejects(
      json(`${net.url}/control`, {
        method: "POST",
        body: JSON.stringify({ method: "advanceSlots", params: [2] }),
        signal: AbortSignal.timeout(40_000),
      }),
      /sync_contributions_|Incomplete native barrier/,
    );
  } finally {
    if (previousTimeout === undefined) Deno.env.delete("PANDA_TIMEOUT_MS");
    else Deno.env.set("PANDA_TIMEOUT_MS", previousTimeout);
  }
  const elapsedMs = performance.now() - started;
  assert(elapsedMs < 40_000, "missing-key failure must use a bounded real deadline");
  const stopped = await net.lifecycle();
  assert.equal(stopped.ready, false);
  assert.equal(stopped.phase, "faulted");
  assert.equal(stopped.slot, nextSlot, "must stop before producing the following block");
  // Private read-only evidence remains available after managed user ingress is faulted.
  const headUrl = `${manifest.beacon}/eth/v1/beacon/headers/head`;
  const head = await json(headUrl);
  await assert.rejects(net.stepSlot(), /faulted/);
  await delay(100);
  assert.deepEqual(await json(headUrl), head);
  failureSafety = { removedIndex, elapsedMs, stoppedSlot: stopped.slot };
}
await profileReport(before, "warp-economics", {
  passed: failures.length === 0,
  criteria: ["W03", "W04", "W07"],
  scope: "96-slot healthy fixed-registry regression; not full acceptance or performance",
  samples,
  failures,
  failureSafety,
});
assert.deepEqual(failures, [], "Honest warp requirements failed");
