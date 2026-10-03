/** Real cold-restart regression. This fixture is not a public stop/resume or snapshot API. */
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Controller } from "../../../src/controller.ts";
import { account, privateKey } from "../../../src/config.ts";
import {
  type ClockState,
  Consensus,
  executionAt,
  finalizedExecutionHash,
} from "../../../src/consensus.ts";
import { LABEL, ROLE } from "../../../src/docker.ts";
import { EngineGate } from "../../../src/engine.ts";
import { json, rpc, waitFor } from "../../../src/http.ts";
import { clockEnvironment } from "../../../src/profiles.ts";
import { exportSigningHistory, retainedSigningHistory } from "./signing_history.ts";
import {
  assertFullBitvector,
  assertFullParticipation,
  assertNoAttestationPenalties,
  assertSigningHistory,
  type AttestationReward,
} from "./warp_assertions.ts";

type Block = {
  version: string;
  data: {
    signature: string;
    message: { slot: string; state_root: string; body: Record<string, unknown> };
  };
};
type Restart = "none" | "cl" | "all";

async function restartClients(c: Controller, restart: Exclude<Restart, "none">, nowMs: number) {
  const m = c.manifest;
  const infra = c.network.infra;
  const roles = restart === "all" ? ["vc", "bn", "el"] : ["vc", "bn"];
  const saved = [];
  // Reverse dependency order, graceful exits, exact owner, retained volumes and signing DB.
  for (const role of roles) {
    const found = await infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${m.config.id}`, `${ROLE}=${role}`] },
    });
    assert.equal(found.length, 1, `expected one owned ${role}`);
    const container = infra.docker.getContainer(found[0].Id);
    const info = await container.inspect();
    assert.equal(info.Config.Labels?.[LABEL], m.config.id);
    await container.stop({ t: 60 });
    const stopped = await container.inspect();
    assert.equal(stopped.State.OOMKilled, false);
    assert.equal(stopped.State.ExitCode, 0, `${role} did not stop gracefully`);
    await Deno.writeTextFile(
      `${m.directory}/${role}-before-restart-${nowMs}.log`,
      await infra.logs(container),
    );
    saved.push({ role, info });
    await container.remove();
  }
  if (restart === "all") await c.network.engine?.close();
  for (const { role, info } of saved.reverse()) {
    const { startMs } = clockEnvironment(m.bake.recipe);
    const env = (info.Config.Env ?? []).filter((entry) => !entry.startsWith(`${startMs}=`));
    const network = info.HostConfig.NetworkMode;
    assert(network, "owned container must have a Docker network");
    const container = await infra.container(role, {
      Image: info.Image,
      User: info.Config.User,
      Entrypoint: info.Config.Entrypoint,
      Cmd: info.Config.Cmd?.map((arg) =>
        arg.startsWith("--execution-endpoint=")
          ? `--execution-endpoint=${c.network.engine!.url}`
          : arg
      ).filter((arg) => arg !== "--init-slashing-protection"),
      Env: role === "el" ? env : [...env, `${startMs}=${nowMs}`],
      ExposedPorts: info.Config.ExposedPorts,
      HostConfig: {
        ...info.HostConfig,
        PortBindings: Object.fromEntries(
          Object.keys(info.Config.ExposedPorts ?? {}).map((
            key,
          ) => [key, [{ HostIp: "127.0.0.1", HostPort: "" }]]),
        ),
      },
      NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [role] } } },
    });
    await container.start();
    const ports = (await container.inspect()).NetworkSettings.Ports;
    const url = (n: number) => {
      const port = ports[`${n}/tcp`]?.[0]?.HostPort;
      assert(port, `missing published ${role} port ${n}`);
      return `http://127.0.0.1:${port}`;
    };
    if (role === "el") {
      m.el = url(8545);
      await waitFor("restarted Geth", () => rpc(m.el, "eth_chainId"));
      c.network.engine = await EngineGate.start(
        infra,
        container,
        url(8551),
        nowMs,
        await Deno.readTextFile(`${m.directory}/jwt/jwtsecret`),
      );
    } else if (role === "bn") {
      m.beacon = url(5052);
      m.bnClock = url(5059);
      await waitFor("restarted beacon", () => json(`${m.beacon}/eth/v1/beacon/headers/head`));
    } else {
      m.vc = url(5062);
      m.vcClock = url(5059);
      await waitFor("restarted validator duties", async () => {
        const state = await json<ClockState>(m.vcClock);
        return state.nowMs === nowMs && state.marks.ready === 0 && state.marks.indices !== undefined
          ? true
          : undefined;
      });
    }
  }
  await Deno.writeTextFile(`${m.directory}/manifest.json`, JSON.stringify(m, null, 2));
}

async function sample(restart: Restart, cuts: number[], continuation: boolean) {
  const c = await Controller.start({ id: `restart-${restart}-${crypto.randomUUID().slice(0, 8)}` });
  const m = c.manifest;
  let timeline = c.time;
  try {
    const checkpoints = [];
    for (const cut of cuts) {
      await timeline.advanceSlots(cut - timeline.slot);
      const before = await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`);
      const beforeEl = await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["latest", false]);
      const clock = await json<ClockState>(m.bnClock);
      assert.equal(clock.nowMs, (await json<ClockState>(m.vcClock)).nowMs);
      assert.equal(clock.marks.fork_choice, cut, "cut must follow the fork-choice barrier");
      const history = continuation ? await exportSigningHistory(m) : undefined;
      if (restart !== "none") {
        await restartClients(c, restart, clock.nowMs);
        assert.deepEqual(
          await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`),
          before,
          "restart changed the checkpoint block",
        );
        assert.equal(
          (await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["latest", false])).hash,
          beforeEl.hash,
          "restart changed EL head",
        );
        if (history) {
          const restored = await exportSigningHistory(m);
          assertSigningHistory(restored, history);
          assert.deepEqual(
            restored,
            retainedSigningHistory(history, cut),
            "restart changed retained signing protection beyond upstream pruning",
          );
        }
      }
      timeline = await Consensus.connect(m, c.network.engine);
      await timeline.stepSlot();
      const next = await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`);
      assert.equal(Number(next.data.message.slot), cut + 1);
      assert.equal(
        (await executionAt(m, "head")).block_hash,
        (await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["latest", false])).hash,
      );
      checkpoints.push({ cut, before, next });
      console.log(JSON.stringify({ event: "restart-cut-checked", restart, cut }));
    }
    let continued;
    if (continuation) {
      const history = await exportSigningHistory(m);
      assert.equal(history.data.length, m.config.validators);
      const resumedSlot = timeline.slot;
      // The first submitted transaction must enter the next block; no automine race.
      const wallet = new Wallet(privateKey);
      const signed = await wallet.signTransaction({
        chainId: m.config.chainId,
        nonce: 0,
        to: account,
        value: 1n,
        gasLimit: 1_000_000n,
        maxFeePerGas: 10_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        type: 2,
      });
      const hash = await rpc<string>(m.el, "eth_sendRawTransaction", [signed]);
      await timeline.stepSlot();
      const receipt = await rpc<{ status: string; blockHash: string } | null>(
        m.el,
        "eth_getTransactionReceipt",
        [hash],
      );
      assert(receipt, "transaction after restart was not included");
      assert.equal(receipt.status, "0x1");
      assert.equal(receipt.blockHash, (await executionAt(m, "head")).block_hash);
      await timeline.advanceSlots(96);
      const head = await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`);
      const state = await json<{
        execution_optimistic: boolean;
        data: {
          previous_epoch_participation: string[];
          inactivity_scores: string[];
          validators: { slashed: boolean }[];
        };
      }>(`${m.beacon}/eth/v2/debug/beacon/states/head`, {
        headers: { accept: "application/json" },
      });
      assert.equal(state.execution_optimistic, false);
      assertFullParticipation(
        state.data.previous_epoch_participation,
        state.data.inactivity_scores,
        m.config.validators,
      );
      assert(state.data.validators.every((v) => !v.slashed));
      const epoch = Math.floor(timeline.slot / 32);
      const rewards = await json<{ data: { total_rewards: AttestationReward[] } }>(
        `${m.beacon}/eth/v1/beacon/rewards/attestations/${epoch - 2}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "[]" },
      );
      assertNoAttestationPenalties(rewards.data.total_rewards, m.config.validators);
      const finality = await json<{ data: { finalized: { epoch: string; root: string } } }>(
        `${m.beacon}/eth/v1/beacon/states/head/finality_checkpoints`,
      );
      assert(Number(finality.data.finalized.epoch) >= epoch - 2, "finality did not resume");
      const finalized = await finalizedExecutionHash(m);
      assert.equal(
        (await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["finalized", false])).hash,
        finalized,
      );
      for (let slot = resumedSlot; slot <= timeline.slot; slot++) {
        const block = await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/${slot}`);
        const body = block.data.message.body as {
          sync_aggregate: { sync_committee_bits: string };
          payload_attestations: { aggregation_bits: string }[];
        };
        assertFullBitvector(body.sync_aggregate.sync_committee_bits, 512, `sync at ${slot}`);
        const mask = body.payload_attestations.reduce((n, v) => n | BigInt(v.aggregation_bits), 0n);
        assertFullBitvector(`0x${mask.toString(16)}`, 512, `PTC at ${slot}`);
      }
      const finalHistory = await exportSigningHistory(m);
      assertSigningHistory(finalHistory, history, resumedSlot);
      continued = {
        head,
        receipt,
        finality,
        finalized,
        rewards,
        history: retainedSigningHistory(finalHistory, timeline.slot),
      };
    }
    return {
      bakeKey: m.bake.key,
      bake: m.bake.tag,
      profile: m.config.profile,
      checkpoints,
      continued,
    };
  } finally {
    await c.close();
  }
}

export async function runRestart(selected: "cl" | "all", cuts = [3], continuation = false) {
  assert(
    cuts.length > 0 &&
      cuts.every((cut, i) =>
        Number.isSafeInteger(cut) && cut >= 1 && (i === 0 || cut > cuts[i - 1])
      ),
  );
  // Bound this regression, independently of the runtime watchdog default.
  if (!Deno.env.has("PANDA_TIMEOUT_MS")) Deno.env.set("PANDA_TIMEOUT_MS", "60000");
  const uninterrupted = await sample("none", cuts, continuation);
  const resumed = await sample(selected, cuts, continuation);
  await Deno.mkdir(".cache/p0-p1", { recursive: true });
  await Deno.writeTextFile(
    `.cache/p0-p1/restart-${resumed.profile}-${resumed.bake}-${selected}.json`,
    JSON.stringify({ uninterrupted, resumed }, null, 2),
  );
  assert.equal(resumed.bakeKey, uninterrupted.bakeKey);
  // Entire signed blocks: all aggregation bits, signatures, PTC fields and resulting state roots.
  assert.deepEqual(resumed.checkpoints, uninterrupted.checkpoints, "restart changed continuation");
  assert.deepEqual(resumed.continued, uninterrupted.continued, "post-restart execution diverged");
  const result = {
    event: "restart-passed",
    profile: resumed.profile,
    bake: resumed.bake,
    bakeKey: resumed.bakeKey,
    restart: selected,
    cuts,
    continuation,
    checkpoints: resumed.checkpoints.map(({ cut, before, next }) => ({
      cut,
      beforeStateRoot: before.data.message.state_root,
      nextStateRoot: next.data.message.state_root,
      nextSignature: next.data.signature,
    })),
    final: resumed.continued && {
      slot: resumed.continued.head.data.message.slot,
      stateRoot: resumed.continued.head.data.message.state_root,
      finalized: resumed.continued.finality.data.finalized,
      executionFinalized: resumed.continued.finalized,
      transaction: resumed.continued.receipt,
      signingValidators: resumed.continued.history.data.length,
    },
  };
  console.log(JSON.stringify(result));
  return result;
}

if (import.meta.main) {
  const selected = Deno.args[0];
  if (selected !== "cl" && selected !== "all") throw new Error("Usage: restart.ts cl|all");
  await runRestart(selected);
}
