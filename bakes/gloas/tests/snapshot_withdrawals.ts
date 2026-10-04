import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { account } from "../../../src/config.ts";
import { Network } from "../../../src/network.ts";
import { StateStore } from "../../../src/storage.ts";
import { send } from "../../shared/tests/deposit_fixture.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { exportSigningHistory } from "../../shared/tests/signing_history.ts";
import { exitValidator, validator, type ValidatorRecord } from "../../shared/tests/validators.ts";
import { assertSigningHistory } from "../../shared/tests/warp_assertions.ts";

const SOURCE = 0;
const TARGET = 1;
const EXITING = 2;
const SLOTS_PER_EPOCH = 32;
const GWEI = 1_000_000_000n;
const CONSOLIDATION = "0x0000BBdDc7CE488642fb579F8B00f3a590007251";
const id = `snapshot-withdrawals-${crypto.randomUUID().slice(0, 8)}`;
const store = new StateStore(id);
const started = performance.now();
let net: Devnet | undefined;
let passed = false;
type SignedExit = { message: { epoch: string; validator_index: string }; signature: string };
type Withdrawal = { index: string; validatorIndex: string; amount: string; address: string };
interface QueueState {
  slot: string;
  pending_consolidations: { source_index: string; target_index: string }[];
  pending_partial_withdrawals: unknown[];
  earliest_consolidation_epoch: string;
  consolidation_balance_to_consume: string;
  earliest_exit_epoch: string;
  exit_balance_to_consume: string;
  next_withdrawal_index: string;
  next_withdrawal_validator_index: string;
}
async function queues() {
  const response = await net!.beacon<{ data: QueueState }>("/eth/v2/debug/beacon/states/head");
  const state = response.data;
  return {
    slot: state.slot,
    consolidations: state.pending_consolidations,
    partialWithdrawals: state.pending_partial_withdrawals,
    earliestConsolidation: state.earliest_consolidation_epoch,
    consolidationBalance: state.consolidation_balance_to_consume,
    earliestExit: state.earliest_exit_epoch,
    exitBalance: state.exit_balance_to_consume,
    withdrawalIndex: state.next_withdrawal_index,
    withdrawalValidatorIndex: state.next_withdrawal_validator_index,
  };
}
async function exits() {
  return (await net!.beacon<{ data: SignedExit[] }>("/eth/v1/beacon/pool/voluntary_exits")).data;
}
async function requestConsolidation(source: number, target: number) {
  const from = await validator(net!, source);
  const to = await validator(net!, target);
  const fee = BigInt(
    await net!.rpc<string>("eth_call", [{ to: CONSOLIDATION, data: "0x" }, "latest"]),
  );
  await net!.setAutomine(true);
  try {
    return await send(
      net!,
      CONSOLIDATION,
      from.validator.pubkey + to.validator.pubkey.slice(2),
      fee,
    );
  } finally {
    await net!.setAutomine(false);
  }
}
async function skipTo(slot: number) {
  const before = await net!.status();
  assert(slot >= before.slot);
  if (slot !== before.slot) await net!.skipSlots(slot - before.slot);
  assert.equal((await net!.status()).el.hash, before.el.hash, "skip must not fabricate payouts");
}
async function completeBranch() {
  const seen = new Set<string>();
  const withdrawals: Withdrawal[] = [];
  let includedExits = 0;
  async function step() {
    const before = BigInt(await net!.rpc<string>("eth_getBalance", [account, "latest"]));
    await net!.stepSlot();
    const block = await net!.rpc<{ withdrawals: Withdrawal[] }>("eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const native = await net!.beacon<
      { data: { message: { body: { voluntary_exits: SignedExit[] } } } }
    >(
      "/eth/v2/beacon/blocks/head",
    );
    includedExits +=
      native.data.message.body.voluntary_exits.filter((exit) =>
        Number(exit.message.validator_index) === EXITING
      ).length;
    let credited = 0n;
    for (const withdrawal of block.withdrawals) {
      assert(!seen.has(withdrawal.index), "duplicate withdrawal index in one branch");
      seen.add(withdrawal.index);
      if (withdrawal.address.toLowerCase() === account.toLowerCase()) {
        credited += BigInt(withdrawal.amount) * GWEI;
      }
      if ([SOURCE, EXITING].includes(Number(BigInt(withdrawal.validatorIndex)))) {
        withdrawals.push(withdrawal);
      }
    }
    assert.equal(
      BigInt(await net!.rpc<string>("eth_getBalance", [account, "latest"])),
      before + credited,
      "execution account must receive the actual withdrawal amounts; there are no transactions here",
    );
  }
  for (let i = 0; i < 4 && (await validator(net!, EXITING)).status === "active_ongoing"; i++) {
    await step();
  }
  const exiting = await validator(net!, EXITING);
  assert.equal(exiting.status, "active_exiting");
  assert.equal(includedExits, 1, "the saved signed exit must enter exactly one block");
  assert(
    Number(exiting.validator.withdrawable_epoch) >= Number(exiting.validator.exit_epoch) + 256,
  );
  const source = await validator(net!, SOURCE);
  const sourceSlot = Number(source.validator.withdrawable_epoch) * SLOTS_PER_EPOCH;
  const exitSlot = Number(exiting.validator.withdrawable_epoch) * SLOTS_PER_EPOCH;
  assert(
    Math.abs(sourceSlot - exitSlot) <= 64,
    "unexpected queue delay in this 64-validator fixture",
  );
  await skipTo(Math.min(sourceSlot, exitSlot) - 1);
  const targetBefore = BigInt((await validator(net!, TARGET)).balance);
  let consolidated: ValidatorRecord | undefined;
  let paid: ValidatorRecord | undefined;
  for (let i = 0; i < Math.abs(sourceSlot - exitSlot) + 64; i++) {
    await step();
    const currentSource = await validator(net!, SOURCE);
    if (!consolidated && currentSource.balance === "0") consolidated = currentSource;
    if (
      withdrawals.some((w) =>
        Number(BigInt(w.validatorIndex)) === EXITING && BigInt(w.amount) > 16n * GWEI
      )
    ) {
      paid = await validator(net!, EXITING);
    }
    if (consolidated && paid) break;
  }
  assert(consolidated, "consolidation did not empty the source");
  assert(paid, "missing full exit payout in an actual execution payload");
  assert(BigInt(paid.balance) < GWEI);
  const targetAfter = BigInt((await validator(net!, TARGET)).balance);
  assert(
    targetAfter > targetBefore + 16n * GWEI,
    "consolidation principal did not reach the target",
  );
  assert(!(await queues()).consolidations.some((entry) => Number(entry.source_index) === SOURCE));
  // Exited sync committee members may receive small rewards until the next real rotation.
  const nextCommitteeEpoch = (Math.floor(Number(exiting.validator.withdrawable_epoch) / 256) + 1) *
    256;
  await skipTo(nextCommitteeEpoch * SLOTS_PER_EPOCH - 1);
  for (let i = 0; i < 64; i++) {
    await step();
    const record = await validator(net!, EXITING);
    if (record.status === "withdrawal_done" && record.balance === "0") break;
  }
  const exited = await validator(net!, EXITING);
  assert.equal(exited.status, "withdrawal_done");
  assert.equal(exited.balance, "0");
  for (let i = 0; i < 128; i++) await step();
  assert.equal(includedExits, 1, "the restored exit was included more than once");
  assert.equal(
    withdrawals.filter((w) =>
      Number(BigInt(w.validatorIndex)) === EXITING && BigInt(w.amount) > 16n * GWEI
    ).length,
    1,
    "full exit payout must occur once per branch",
  );
  assert.equal(
    withdrawals.filter((w) =>
      Number(BigInt(w.validatorIndex)) === SOURCE && BigInt(w.amount) > 16n * GWEI
    ).length,
    0,
    "consolidation must transfer the source principal in CL, not pay it through EL",
  );
  const status = await net!.status();
  assert(Number(status.finality.data.finalized.epoch) >= Math.floor(status.slot / 32) - 2);
  const finalized = await net!.beacon<{
    execution_optimistic: boolean;
    data: {
      message: {
        body: {
          signed_execution_payload_bid: { message: { parent_block_hash: string } };
        };
      };
    };
  }>("/eth/v2/beacon/blocks/finalized");
  assert.equal(finalized.execution_optimistic, false);
  assert.equal(
    (await net!.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false])).hash,
    finalized.data.message.body.signed_execution_payload_bid.message.parent_block_hash,
  );
  assertSigningHistory(await exportSigningHistory(await Network.manifest(id)));
  return {
    exiting,
    consolidated,
    exited,
    targetBefore: String(targetBefore),
    targetAfter: String(targetAfter),
    includedExits,
    withdrawals,
    finalizedEpoch: status.finality.data.finalized.epoch,
    slot: status.slot,
  };
}
try {
  // Explicit consolidation capacity for 64 keys; mainnet eligibility/withdrawal delays are retained.
  net = await Devnet.start({
    id,
    profile: "gloas",
    churnLimitQuotient: 4,
    consolidationChurnLimitQuotient: 4,
  });
  await net.advanceSlots(128);
  assert(BigInt((await net.status()).finality.data.finalized.epoch) >= 2n);
  await skipTo(256 * SLOTS_PER_EPOCH);
  await net.stepSlot();
  await requestConsolidation(TARGET, TARGET);
  await net.advanceUntil(
    async () => (await validator(net!, TARGET)).validator.withdrawal_credentials.startsWith("0x02"),
    { maxSlots: 4, timeoutMs: 180_000 },
  );
  const consolidationTx = await requestConsolidation(SOURCE, TARGET);
  await net.advanceUntil(
    async () =>
      (await queues()).consolidations.some((entry) =>
        Number(entry.source_index) === SOURCE && Number(entry.target_index) === TARGET
      ),
    { maxSlots: 4, timeoutMs: 180_000 },
  );
  await exitValidator(net, EXITING);
  const pendingExits = await exits();
  assert.equal(
    pendingExits.filter((exit) => Number(exit.message.validator_index) === EXITING).length,
    1,
  );
  assert.equal((await validator(net, EXITING)).status, "active_ongoing");
  const pending = await queues();
  assert.equal(
    pending.consolidations.filter((entry) => Number(entry.source_index) === SOURCE).length,
    1,
  );
  const records = await Promise.all(
    [SOURCE, TARGET, EXITING].map((index) => validator(net!, index)),
  );
  const saved = await net.status();
  const receipt = await net.rpc("eth_getTransactionReceipt", [consolidationTx]);
  const snapshot = await net.createSnapshot();
  assert.deepEqual(await queues(), pending);
  assert.deepEqual(await exits(), pendingExits);
  console.log(JSON.stringify({ event: "snapshot-withdrawal-queues-saved", slot: saved.slot }));
  const first = await completeBranch();
  console.log(
    JSON.stringify({ event: "snapshot-withdrawals-first-branch-passed", slot: first.slot }),
  );
  await net.restoreSnapshot(snapshot);
  assert.deepEqual(await queues(), pending, "restore changed the consolidation/withdrawal queues");
  assert.deepEqual(await exits(), pendingExits, "restore lost or changed the signed exit pool");
  assert.deepEqual(
    await Promise.all([SOURCE, TARGET, EXITING].map((index) => validator(net!, index))),
    records,
  );
  assert.deepEqual(await net.rpc("eth_getTransactionReceipt", [consolidationTx]), receipt);
  assert.equal((await net.status()).el.hash, saved.el.hash);
  const restored = await completeBranch();
  assert.deepEqual(
    restored,
    first,
    "identical operations after restore changed the protocol outcome",
  );
  await profileReport(saved, "snapshot-withdrawals", {
    passed: true,
    elapsedMs: performance.now() - started,
    savedSlot: saved.slot,
    pending,
    signedExits: pendingExits.length,
    first,
    restored,
  });
  passed = true;
} finally {
  await net?.close();
  if (passed) {
    assert.equal(await store.active(), undefined);
    await Deno.remove(store.root, { recursive: true });
  }
}
