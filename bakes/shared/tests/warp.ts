import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Devnet, type WarpMode } from "../../../src/api.ts";
import { captureWarpRewards } from "./warp_rewards.ts";
import { account, privateKey } from "../../../src/config.ts";
import { executionAt, finalizedExecutionHash } from "../../../src/consensus.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { Network } from "../../../src/network.ts";
import { deadline, delay, json } from "../../../src/http.ts";
import { report } from "./report.ts";
import type { ValidatorRecord } from "./validators.ts";
import {
  assertFullBitvector,
  assertNoAttestationPenalties,
  assertSigningHistory,
  type AttestationReward,
} from "./warp_assertions.ts";
import { exportSigningHistory } from "./signing_history.ts";

export function warpScenario(mode: WarpMode, requestedSlots?: number) {
  const defaultSlots = mode === "honest" ? 1000 : 8192;
  const slots = requestedSlots ?? defaultSlots;
  assert(Number.isSafeInteger(slots) && slots > 32, "Warp fixture requires more than one epoch");
  const base = mode === "fast" ? "warp-fast" : "warp";
  return { slots, name: slots === defaultSlots ? base : `${base}-${slots}` };
}

export async function runWarp(mode: WarpMode, requestedSlots?: number): Promise<void> {
  const { slots, name: scenario } = warpScenario(mode, requestedSlots);
  const started = performance.now();
  await using net = await Devnet.start({ id: `warp-${crypto.randomUUID().slice(0, 8)}` });
  const initial = await net.status();
  const manifest = await Network.manifest(initial.id);
  const infra = new Infrastructure(initial.id);
  const docker = await infra.docker.info();
  const beaconContainer = await infra.docker.getContainer(`panda-${initial.id}-bn`).inspect();
  const environment = {
    architecture: docker.Architecture,
    dockerVersion: docker.ServerVersion,
    dockerCpus: docker.NCPU,
    dockerMemoryBytes: docker.MemTotal,
    beaconCpuLimit: (beaconContainer.HostConfig.NanoCpus ?? 0) / 1e9,
    beaconHierarchy:
      beaconContainer.Config.Cmd?.find((arg) => arg.startsWith("--hierarchy-exponents=")) ??
        "upstream default",
    validators: manifest.config.validators,
    otherContainers:
      (await infra.docker.listContainers()).filter((c) => c.Labels[LABEL] !== initial.id).length,
  };
  const wallet = new Wallet(privateKey);
  const records = async () =>
    (await net.beacon<{ data: ValidatorRecord[] }>("/eth/v1/beacon/states/head/validators")).data;
  const allUnslashed = async () => {
    const validators = await records();
    assert.equal(validators.length, manifest.config.validators);
    assert(
      validators.every((v) => !v.validator.slashed),
      "A validator was slashed after time travel",
    );
    assert(
      validators.every((v) => v.status === "active_ongoing"),
      "Time travel unexpectedly ejected a validator",
    );
    return validators;
  };
  await net.advanceUntil(
    async () => Number((await net.status()).finality.data.finalized.epoch) >= 2,
    { maxSlots: 160 },
  );
  await allUnslashed();
  const beforeHistory = await exportSigningHistory(manifest);
  assert.equal(beforeHistory.data.length, manifest.config.validators);
  assertSigningHistory(beforeHistory);
  let previousHistory = beforeHistory;
  const samples = [];
  // Separate contracts: fast must be ready in seconds; honest preserves every duty.
  const watchdogMs = mode === "fast"
    ? 25_000
    : (manifest.config.profile === "gloas" ? 20 : 55) * 60_000;
  // Honest checks every duty in two 1000-slot ranges; fast retains two committee-period jumps.
  for (let index = 0; index < 2; index++) {
    const before = await net.status();
    const target = before.now + slots * 12;
    const start = performance.now();
    let finished = false;
    const captured = mode === "honest"
      ? captureWarpRewards(
        Math.floor(before.slot / 32),
        async () => {
          const head = await net.beacon<{ data: { header: { message: { slot: string } } } }>(
            "/eth/v1/beacon/headers/head",
          );
          return Math.floor(Number(head.data.header.message.slot) / 32);
        },
        async (epoch) => {
          const rewards = await json<{ data: { total_rewards: AttestationReward[] } }>(
            `${manifest.beacon}/eth/v1/beacon/rewards/attestations/${epoch}`,
            { method: "POST", headers: { "content-type": "application/json" }, body: "[]" },
          );
          return rewards.data.total_rewards;
        },
        () => finished,
      )
      : Promise.resolve([]);
    const advanceAndTransact = async () => {
      try {
        if (index === 0) await net.advanceTime(slots * 12, { mode });
        else await net.advanceTo(new Date(target * 1000), { mode });
        const advanceMs = performance.now() - start;
        const advanced = await net.status();
        assert.equal(advanced.now, target);
        assert.equal(advanced.slot, before.slot + slots);
        assert.notEqual(advanced.el.hash, before.el.hash);
        assert.equal(
          Number(BigInt(advanced.el.timestamp)),
          manifest.config.genesisTime + advanced.slot * 12,
        );
        assert.equal((await executionAt(manifest, "head")).block_hash, advanced.el.hash);
        await net.setAutomine(true);
        const nonce = Number(
          BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "latest"])),
        );
        const signed = await wallet.signTransaction({
          chainId: manifest.config.chainId,
          nonce,
          to: account,
          value: 1n,
          gasLimit: 1_000_000n,
          maxFeePerGas: 10_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
          type: 2,
        });
        const hash = await net.rpc<string>("eth_sendRawTransaction", [signed]);
        const receipt = await net.waitForService(
          "transaction after warp",
          async () =>
            (await net.rpc<{ status: string; blockHash: string; blockNumber: string } | null>(
              "eth_getTransactionReceipt",
              [hash],
            )) ?? undefined,
          10_000,
        );
        assert.equal(receipt.status, "0x1");
        assert.equal(BigInt(receipt.blockNumber), BigInt(advanced.el.number) + 1n);
        await net.setAutomine(false);
        const readyMs = performance.now() - start;
        assert(readyMs < watchdogMs, "Warp plus the first transaction exceeded its mode budget");
        const after = await net.status();
        assert.equal(after.el.hash, receipt.blockHash);
        return { advanceMs, advanced, receipt, readyMs, after };
      } finally {
        finished = true;
      }
    };
    let measured: Awaited<ReturnType<typeof advanceAndTransact>>;
    let epochRewards: Awaited<ReturnType<typeof captureWarpRewards>>;
    try {
      [measured, epochRewards] = await deadline(
        Promise.all([advanceAndTransact(), captured]),
        watchdogMs,
        `${mode} warp including its next transaction exceeded the regression watchdog`,
      );
    } catch (error) {
      finished = true;
      await report(net, scenario, {
        passed: false,
        mode,
        watchdogMs,
        environment,
        slots,
        elapsedMs: performance.now() - start,
        samples,
        failure: String(error),
        before,
        interrupted: await net.status(),
      });
      throw error;
    }
    const { advanceMs, advanced, receipt, readyMs, after } = measured;
    // Persist measured time before the slower read-only assertions, even if one later fails.
    await report(net, scenario, {
      passed: false,
      status: "validating",
      mode,
      watchdogMs,
      environment,
      samples: [...samples, { advanceMs, readyMs, slots, targetSlot: advanced.slot, receipt }],
    });
    await allUnslashed();
    const produced = BigInt(advanced.el.number) - BigInt(before.el.number);
    if (mode === "honest") {
      assert.equal(produced, BigInt(slots), "Honest warp skipped proposals");
      assert(
        Number(advanced.finality.data.finalized.epoch) >= Math.floor(advanced.slot / 32) - 2,
        "Warp returned with stale finality",
      );
      // Check every produced sync aggregate, including the committee rotation between jumps.
      // Read-only validation follows the measured advance + first transaction interval.
      for (let first = before.slot + 1; first <= advanced.slot; first += 8) {
        await Promise.all(
          Array.from({ length: Math.min(8, advanced.slot - first + 1) }, async (_, i) => {
            const slot = first + i;
            const block = await net.beacon<{
              execution_optimistic: boolean;
              data: {
                message: {
                  slot: string;
                  body: { sync_aggregate: { sync_committee_bits: string } };
                };
              };
            }>(`/eth/v2/beacon/blocks/${slot}`);
            assert.equal(block.execution_optimistic, false);
            assert.equal(Number(block.data.message.slot), slot);
            assertFullBitvector(
              block.data.message.body.sync_aggregate.sync_committee_bits,
              512,
              `sync at ${slot}`,
            );
          }),
        );
      }
      for (const sample of epochRewards) {
        assertNoAttestationPenalties(sample.rewards, manifest.config.validators);
      }
      assert.equal(
        epochRewards.length,
        Math.floor(after.slot / 32) - 1 - Math.floor(before.slot / 32),
      );
    } else {
      assert.equal(produced, 1n, "Fast warp must produce the destination after the skipped gap");
    }
    if (mode === "fast") {
      // Skipped states must be accessible while unfinalized. Lighthouse prunes history later.
      const skipped = await net.beacon<{ data: { root: string } }>(
        `/eth/v1/beacon/states/${advanced.slot - 64}/root`,
      );
      assert.match(skipped.data.root, /^0x[0-9a-f]{64}$/);
      assert.equal(
        (await net.beacon<{ data: ValidatorRecord[] }>(
          `/eth/v1/beacon/states/${skipped.data.root}/validators`,
        )).data.length,
        manifest.config.validators,
      );
    }
    const head = await net.beacon("/eth/v1/beacon/headers/head");
    await delay(250);
    assert.deepEqual(await net.beacon("/eth/v1/beacon/headers/head"), head);
    assert.equal((await net.status()).el.hash, after.el.hash);
    samples.push({
      advanceMs,
      slots,
      readyMs,
      targetSlot: advanced.slot,
      receipt,
      syncBlocksChecked: mode === "honest" ? slots : 0,
      rewardEpochsChecked: epochRewards.length,
      penaltiesAllowed: mode === "fast",
      finalizedBefore: before.finality.data.finalized,
    });
    console.log(JSON.stringify({ event: "warp-sample", ...samples.at(-1) }));
    // Real new finality must reach a checkpoint after the jump, not merely stay nonzero.
    await net.advanceUntil(
      async () =>
        Number((await net.status()).finality.data.finalized.epoch) >=
          Math.floor(advanced.slot / 32),
      { maxSlots: 160 },
    );
    const cl = await finalizedExecutionHash(manifest);
    assert.equal(
      (await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false])).hash,
      cl,
    );
    assert.equal(
      (await net.beacon<{ data: ValidatorRecord[] }>(
        "/eth/v1/beacon/states/finalized/validators",
      )).data.length,
      manifest.config.validators,
    );
    const history = await exportSigningHistory(manifest);
    assertSigningHistory(history, previousHistory, advanced.slot);
    previousHistory = history;
  }
  const validators = await allUnslashed();
  const afterHistory = previousHistory;
  assert.deepEqual(
    afterHistory.data.map((v) => v.pubkey.toLowerCase()).sort(),
    validators.map((v) => v.validator.pubkey.toLowerCase()).sort(),
  );
  assertSigningHistory(afterHistory, beforeHistory, samples.at(-1)!.targetSlot);
  await report(net, scenario, {
    event: "warp-measured",
    passed: true,
    mode,
    latencyBudgetMet: samples.every((sample) => sample.readyMs < watchdogMs),
    watchdogMs,
    environment,
    elapsedMs: performance.now() - started,
    samples,
    validators: validators.map((v) => ({
      index: v.index,
      slashed: v.validator.slashed,
      balance: v.balance,
      status: v.status,
    })),
    signedValidators: afterHistory.data.length,
    status: await net.status(),
  });
}

if (import.meta.main) await runWarp("honest");
