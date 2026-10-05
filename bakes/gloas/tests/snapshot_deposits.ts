import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { Network } from "../../../src/network.ts";
import { StateStore } from "../../../src/storage.ts";
import { depositValidator } from "../../shared/tests/deposit_fixture.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { exportSigningHistory } from "../../shared/tests/signing_history.ts";
import { validator, type ValidatorRecord } from "../../shared/tests/validators.ts";
import { assertSigningHistory } from "../../shared/tests/warp_assertions.ts";

const DEPOSITED = 64;
const FAR_FUTURE = "18446744073709551615";
const id = `snapshot-deposits-${crypto.randomUUID().slice(0, 8)}`;
const store = new StateStore(id);
const started = performance.now();
let net: Devnet | undefined;
let passed = false;
interface DepositState {
  slot: string;
  pending_deposits: { pubkey: string; amount: string; slot: string }[];
  deposit_balance_to_consume: string;
  deposit_requests_start_index: string;
  validators: ValidatorRecord["validator"][];
  balances: string[];
}
async function state() {
  const response = await net!.beacon<{ execution_optimistic: boolean; data: DepositState }>(
    "/eth/v2/debug/beacon/states/head",
  );
  assert.equal(response.execution_optimistic, false);
  const value = response.data;
  // Select the independently observed deposit/activation state, not snapshot metadata.
  return {
    slot: value.slot,
    pending: value.pending_deposits,
    balanceToConsume: value.deposit_balance_to_consume,
    requestsStartIndex: value.deposit_requests_start_index,
    validators: value.validators,
    balances: value.balances,
  };
}
async function deposited() {
  try {
    return await validator(net!, DEPOSITED);
  } catch (error) {
    if (String(error).includes("404")) return;
    throw error;
  }
}
async function activate(pubkey: string) {
  await net!.advanceUntil(async () => (await deposited())?.status === "active_ongoing", {
    maxSlots: 512,
    timeoutMs: 600_000,
  });
  const record = await validator(net!, DEPOSITED);
  const current = await state();
  assert.equal(record.validator.pubkey, pubkey);
  assert.equal(record.status, "active_ongoing");
  assert.equal(current.validators.length, DEPOSITED + 1);
  assert.equal(current.validators.filter((entry) => entry.pubkey === pubkey).length, 1);
  assert.equal(current.pending.filter((entry) => entry.pubkey === pubkey).length, 0);
  assert(BigInt(record.balance) >= 32_000_000_000n);
  assert(BigInt(record.balance) < 33_000_000_000n, "deposit must not be credited twice");
  const logs = await net!.rpc<{ data: string; transactionHash: string; logIndex: string }[]>(
    "eth_getLogs",
    [{
      address: "0x4242424242424242424242424242424242424242",
      fromBlock: "0x0",
      toBlock: "latest",
    }],
  );
  const matching = logs.filter((log) => log.data.includes(pubkey.slice(2)));
  assert.equal(matching.length, 1, "branch must contain exactly one deposit event for the new key");
  return { record, slot: Number(current.slot), deposit: matching[0] };
}
try {
  net = await Devnet.start({ id, profile: "gloas" });
  await net.setAutomine(true);
  let pubkey: string;
  try {
    pubkey = await depositValidator(net, DEPOSITED);
  } finally {
    await net.setAutomine(false);
  }
  await net.advanceUntil(
    async () => (await state()).pending.some((entry) => entry.pubkey === pubkey),
    {
      maxSlots: 4,
      timeoutMs: 120_000,
    },
  );
  const pending = await state();
  assert.equal(pending.pending.filter((entry) => entry.pubkey === pubkey).length, 1);
  assert.equal(pending.pending.find((entry) => entry.pubkey === pubkey)!.amount, "32000000000");
  assert.equal(pending.validators.length, DEPOSITED);
  const depositCut = await net.status();
  const depositSnapshot = await net.createSnapshot();
  assert.deepEqual(await state(), pending, "capture changed the pending deposit");
  console.log(JSON.stringify({ event: "snapshot-pending-deposit-saved", slot: depositCut.slot }));

  await net.advanceUntil(async () => {
    const record = await deposited();
    return record?.status === "pending_queued" && record.validator.activation_epoch !== FAR_FUTURE;
  }, { maxSlots: 512, timeoutMs: 600_000 });
  const queued = await state();
  const queuedRecord = await validator(net, DEPOSITED);
  assert.equal(queued.pending.filter((entry) => entry.pubkey === pubkey).length, 0);
  assert.equal(queued.validators.length, DEPOSITED + 1);
  assert(Number(queuedRecord.validator.activation_epoch) * 32 > Number(queued.slot));
  const activationSnapshot = await net.createSnapshot();
  assert.deepEqual(await state(), queued, "capture changed the activation queue");
  const first = await activate(pubkey);
  console.log(JSON.stringify({ event: "snapshot-deposit-first-activation", slot: first.slot }));

  const restored = [];
  for (
    const [name, snapshot, expected] of [
      ["pending deposit", depositSnapshot, pending],
      ["pending activation", activationSnapshot, queued],
    ] as const
  ) {
    await net.restoreSnapshot(snapshot);
    assert.deepEqual(await state(), expected, `${name} state was not restored exactly`);
    assert.equal((await net.lifecycle()).cleanup?.state, "succeeded");
    const branch = await activate(pubkey);
    assert.deepEqual(branch, first, `${name} changed activation or duplicated the deposit`);
    const manifest = await Network.manifest(id);
    const history = await exportSigningHistory(manifest);
    assertSigningHistory(history);
    assert.equal(history.data.length, DEPOSITED + 1, "restored VC lost the imported validator key");
    restored.push({ cut: name, savedSlot: snapshot.headSlot, activatedSlot: branch.slot });
    console.log(JSON.stringify({ event: "snapshot-deposit-branch-passed", cut: name }));
  }
  await profileReport(depositCut, "snapshot-deposits", {
    passed: true,
    elapsedMs: performance.now() - started,
    depositedValidator: DEPOSITED,
    pendingSlot: depositSnapshot.headSlot,
    activationQueueSlot: activationSnapshot.headSlot,
    activation: first,
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
