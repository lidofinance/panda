/** Real cold-restart regression. No checkpoint API, fabricated votes or snapshot runtime. */
import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { getCreateAddress, Wallet } from "ethers";
import { atomicJson } from "../../../src/artifacts.ts";
import { account, privateKey } from "../../../src/config.ts";
import {
  type ClockState,
  Consensus,
  executionAt,
  finalizedExecutionHash,
} from "../../../src/consensus.ts";
import { replayConsensusMessages } from "../../../src/consensus_messages.ts";
import { Controller } from "../../../src/controller.ts";
import { Infrastructure, LABEL, ROLE } from "../../../src/docker.ts";
import { EngineGate } from "../../../src/engine.ts";
import { deadline, json, rpc, waitFor } from "../../../src/http.ts";
import type { Manifest } from "../../../src/network.ts";
import { clockEnvironment, readBake, sha256 } from "../../../src/profiles.ts";
import { fileInventory } from "../../../src/storage.ts";
import type { Timeline } from "../../../src/time.ts";
import {
  assertFullBitvector,
  assertFullParticipation,
  assertNoAttestationPenalties,
  assertSigningHistory,
  type AttestationReward,
  type SigningHistory,
} from "../../shared/tests/warp_assertions.ts";

type Block = {
  data: {
    signature: string;
    message: {
      slot: string;
      state_root: string;
      body: {
        attestations: { data: { slot: string }; aggregation_bits: string }[];
        payload_attestations: { aggregation_bits: string }[];
        sync_aggregate: { sync_committee_bits: string };
        signed_execution_payload_bid: {
          message: { block_hash: string; parent_block_hash: string };
        };
      };
    };
  };
};
type Receipt = { contractAddress: string | null; status: string; blockHash: string };
type Mode = "uninterrupted" | "cold" | "replay" | "restore";
const requestTimeoutMs = 30_000;

async function record(path: string, value: unknown) {
  await atomicJson(path, value);
}

async function copySigningDatabase(source: string, destination: string) {
  await Deno.mkdir(destination, { recursive: true });
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const name = `slashing_protection.sqlite${suffix}`;
    try {
      await Deno.copyFile(`${source}/${name}`, `${destination}/${name}`);
    } catch (error) {
      if (!suffix || !(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

/** Export only copied, stopped bytes after the run. This process has no validator keys or network. */
async function stoppedSigningHistory(m: Manifest, source: string, destination: string) {
  await copySigningDatabase(source, destination);
  const infra = new Infrastructure(m.config.id);
  const container = await infra.container("history-export", {
    Image: m.bake.images.cl.id,
    User: `${Deno.uid()}:${Deno.gid()}`,
    Entrypoint: [
      "env",
      "-u",
      clockEnvironment(m.bake.recipe).startMs,
      "-u",
      clockEnvironment(m.bake.recipe).port,
      "lighthouse",
    ],
    Cmd: [
      "--testnet-dir=/metadata",
      "account",
      "validator",
      "--validators-dir=/history",
      "slashing-protection",
      "export",
      "/history/history.json",
    ],
    HostConfig: {
      Binds: [
        `${await Deno.realPath(`${m.directory}/metadata`)}:/metadata:ro`,
        `${await Deno.realPath(destination)}:/history`,
      ],
      NetworkMode: "none",
    },
  });
  try {
    await container.start();
    const status = await deadline(container.wait(), requestTimeoutMs, "signing history export");
    await Deno.writeTextFile(`${destination}/export.log`, await infra.logs(container));
    assert.equal(status.StatusCode, 0, "ordinary Lighthouse signing history export failed");
  } finally {
    assert.equal((await container.inspect()).Config.Labels?.[LABEL], m.config.id);
    await container.remove({ force: true });
  }
  const history: SigningHistory = JSON.parse(
    await Deno.readTextFile(`${destination}/history.json`),
  );
  history.data.sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  for (const validator of history.data) {
    validator.signed_blocks.sort((a, b) => Number(BigInt(a.slot) - BigInt(b.slot)));
    validator.signed_attestations.sort((a, b) =>
      Number(BigInt(a.target_epoch) - BigInt(b.target_epoch))
    );
  }
  return history;
}

/** Match the pinned client's ordinary pruning: one epoch and each validator's latest watermark. */
function retainedSigningHistory(history: SigningHistory, slot: number): SigningHistory {
  const minimumEpoch = BigInt(Math.max(0, Math.floor(slot / 32) - 1));
  const result = structuredClone(history);
  const max = (values: string[]) => values.reduce((n, v) => BigInt(v) > n ? BigInt(v) : n, -1n);
  for (const validator of result.data) {
    const proposal = max(validator.signed_blocks.map((v) => v.slot));
    const target = max(validator.signed_attestations.map((v) => v.target_epoch));
    validator.signed_blocks = validator.signed_blocks.filter((v) =>
      BigInt(v.slot) >= minimumEpoch * 32n || BigInt(v.slot) === proposal
    );
    validator.signed_attestations = validator.signed_attestations.filter((v) =>
      BigInt(v.target_epoch) >= minimumEpoch || BigInt(v.target_epoch) === target
    );
  }
  return result;
}

/** Test-only topology replacement using stopped client data and the real signing DB. */
export async function restartClients(
  controller: Controller,
  nowMs: number,
  evidence: string,
  beforeValidator?: (manifest: Manifest) => Promise<void>,
  afterValidatorStopped?: () => Promise<void>,
  databaseMode?: "save" | "restore",
): Promise<void> {
  const m = controller.manifest;
  const infra = controller.network.infra;
  const saved = [];
  for (const role of ["vc", "bn", "el"]) {
    const found = await infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${m.config.id}`, `${ROLE}=${role}`] },
    });
    assert.equal(found.length, 1, `expected exactly one owned ${role}`);
    const container = infra.docker.getContainer(found[0].Id);
    const info = await container.inspect();
    assert.equal(info.Config.Labels?.[LABEL], m.config.id);
    assert.equal(info.Config.Labels?.[ROLE], role);
    assert.equal(info.State.Running, true, `${role} exited before the requested clean stop`);
    await deadline(container.stop({ t: 30 }), requestTimeoutMs + 5_000, `${role} stop`);
    const stopped = await container.inspect();
    assert.equal(stopped.State.Running, false);
    assert.equal(stopped.State.OOMKilled, false);
    assert.equal(stopped.State.ExitCode, 0, `${role} did not exit cleanly`);
    const logs = await infra.logs(container);
    await Deno.writeTextFile(`${evidence}/${role}-shutdown.log`, logs);
    if (role === "bn") {
      assert(logs.includes("Saved beacon chain to disk"), "BN did not confirm persistence");
    }
    if (role === "vc" && databaseMode !== "restore") {
      // Preserve actual stopped bytes. Do not pause/export a live signing DB at the cut.
      // These files are evidence, not a claim of semantic signing-history equivalence.
      await copySigningDatabase(`${m.directory}/validator-keys/keys`, evidence);
      await afterValidatorStopped?.();
    }
    saved.push({ role, info });
    await container.remove();
  }
  await controller.network.engine?.close();
  if (databaseMode === "save") {
    // This proves the backend against separate stopped database copies. The production snapshot
    // store, atomic publication and reusable IDs belong to the next implementation stage.
    const originalDirectory = m.directory;
    const shared = `${evidence}/restored-shared`;
    await Deno.mkdir(shared, { recursive: true });
    for (const name of ["metadata", "validator-keys", "jwt"]) {
      await cp(`${originalDirectory}/${name}`, `${shared}/${name}`, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
    const sharedDirectory = await Deno.realPath(shared);
    const copies: { role: string; source: string; destination: string; type: "bind" | "volume" }[] =
      [];
    for (const { role, info } of saved) {
      for (const mount of info.Mounts ?? []) {
        if (!["el", "bn"].includes(role) || mount.Destination !== `/${role}`) continue;
        if (mount.Type === "bind") {
          assert(m.generation, "bind-backed database requires an owned generation");
          const source = await Deno.realPath(mount.Source);
          assert.equal(
            source,
            await Deno.realPath(`${controller.network.store.generationPath(m.generation)}/${role}`),
          );
          const destination = `${await Deno.realPath(evidence)}/restored-${role}`;
          assert.notEqual(destination, source);
          const before = await fileInventory(source);
          await cp(source, destination, {
            recursive: true,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
          });
          assert.deepEqual(
            await fileInventory(source),
            before,
            `${role} source changed while stopped`,
          );
          assert.deepEqual(
            await fileInventory(destination),
            before,
            `${role} stopped database copy differs`,
          );
          await Deno.writeTextFile(
            `${evidence}/${role}-copy.log`,
            "Stopped bind directory inventory matches.\n",
          );
          copies.push({ role, source, destination, type: "bind" });
          continue;
        }
        assert.equal(mount.Type, "volume", "unsupported database mount type");
        assert(mount.Name, "volume mount has no source name");
        const source = mount.Name;
        assert.equal((await infra.docker.getVolume(source).inspect()).Labels?.[LABEL], m.config.id);
        const destination = await infra.volume(`restored-${role}`);
        assert.notEqual(destination, source);
        const copier = await infra.container(`copy-${role}`, {
          Image: m.bake.images.cl.id,
          User: "0:0",
          Entrypoint: ["/bin/sh"],
          Cmd: [
            "-ec",
            'test -z "$(ls -A /destination)"; cp -a /source/. /destination/; diff -qr /source /destination',
          ],
          HostConfig: {
            Binds: [`${source}:/source:ro`, `${destination}:/destination`],
            NetworkMode: "none",
          },
        });
        try {
          await copier.start();
          const status = await deadline(copier.wait(), requestTimeoutMs, `${role} database copy`);
          await Deno.writeTextFile(`${evidence}/${role}-copy.log`, await infra.logs(copier));
          assert.equal(status.StatusCode, 0, `${role} stopped database copy differs`);
        } finally {
          assert.equal((await copier.inspect()).Config.Labels?.[LABEL], m.config.id);
          await copier.remove({ force: true });
        }
        copies.push({ role, source, destination, type: "volume" });
      }
    }
    assert.deepEqual(copies.map((copy) => copy.role).sort(), ["bn", "el"]);
    await record(`${evidence}/database-copies.json`, { sharedDirectory, copies });
  } else if (databaseMode === "restore") {
    const snapshot: {
      sharedDirectory: string;
      copies: { source: string; destination: string; type: "bind" | "volume" }[];
    } = JSON.parse(await Deno.readTextFile(`${evidence}/database-copies.json`));
    const replacements = new Map([[m.directory, snapshot.sharedDirectory]]);
    for (const copy of snapshot.copies) {
      if (copy.type === "bind") {
        assert.equal(await Deno.realPath(copy.destination), copy.destination);
        assert(copy.destination.startsWith(`${await Deno.realPath(evidence)}/restored-`));
      } else {
        assert.equal(
          (await infra.docker.getVolume(copy.destination).inspect()).Labels?.[LABEL],
          m.config.id,
        );
      }
      replacements.set(copy.source, copy.destination);
    }
    for (const { info } of saved) {
      info.HostConfig.Binds = info.HostConfig.Binds?.map((bind) => {
        const [source, ...options] = bind.split(":");
        return [replacements.get(source) ?? source, ...options].join(":");
      });
    }
    m.directory = snapshot.sharedDirectory;
  }
  for (const { role, info } of saved.reverse()) {
    if (role === "vc") {
      controller.network.prepareValidator();
      await beforeValidator?.(m);
    }
    const { startMs } = clockEnvironment(m.bake.recipe);
    const env = (info.Config.Env ?? []).filter((entry) => !entry.startsWith(`${startMs}=`));
    const network = info.HostConfig.NetworkMode;
    assert(network, "owned client must have a Docker network");
    const container = await infra.container(role, {
      Image: info.Image,
      User: info.Config.User,
      Entrypoint: info.Config.Entrypoint,
      Cmd: info.Config.Cmd?.map((arg) =>
        arg.startsWith("--execution-endpoint=")
          ? `--execution-endpoint=${controller.network.engine!.url}`
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
    const url = (port: number) => {
      const published = ports[`${port}/tcp`]?.[0]?.HostPort;
      assert(published, `missing ${role} port ${port}`);
      return `http://127.0.0.1:${published}`;
    };
    if (role === "el") {
      m.el = url(8545);
      await waitFor("cold Geth RPC", () => rpc(m.el, "eth_chainId"));
      controller.network.engine = await EngineGate.start(
        infra,
        container,
        url(8551),
        nowMs,
        await Deno.readTextFile(`${m.directory}/jwt/jwtsecret`),
      );
    } else if (role === "bn") {
      m.beacon = url(5052);
      m.bnClock = url(5059);
      if (controller.network.beaconRelay) controller.network.beaconRelay.upstream = m.beacon;
      await waitFor("cold Beacon API", () => json(`${m.beacon}/eth/v1/beacon/headers/head`));
      assert.equal((await json<ClockState>(m.bnClock)).nowMs, nowMs);
    } else {
      m.vc = url(5062);
      m.vcClock = url(5059);
      if (m.bake.recipe.ptcReadiness) m.vcMetrics = url(5064);
      controller.network.bindValidator(m);
      await waitFor("cold VC clock and indices", async () => {
        const clock = await json<ClockState>(m.vcClock);
        return clock.nowMs === nowMs && clock.marks.ready === 0 && clock.marks.indices !== undefined
          ? true
          : undefined;
      });
    }
  }
  await record(`${controller.network.store.root}/manifest.json`, m);
}

async function state(
  m: Manifest,
  evidence: string,
  name: string,
  contract: string,
  hashes: string[],
) {
  const response = await fetch(`${m.beacon}/eth/v2/debug/beacon/states/head`, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert.equal(response.status, 200, "full Beacon SSZ read failed");
  assert(response.headers.get("content-type")?.includes("application/octet-stream"));
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 0);
  await Deno.writeFile(`${evidence}/${name}.ssz`, bytes);
  const bn = await json<ClockState>(m.bnClock);
  const vc = await json<ClockState>(m.vcClock);
  assert.equal(bn.nowMs, vc.nowMs, "BN/VC time disagrees");
  const block = await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`);
  const header = await json<{ data: { root: string } }>(
    `${m.beacon}/eth/v1/beacon/headers/head`,
  );
  const slot = Math.floor((bn.nowMs / 1000 - m.config.genesisTime) / 12);
  const syncContributions = [];
  if (slot > 0 && slot === Number(block.data.message.slot)) {
    for (let subnet = 0; subnet < 4; subnet++) {
      const contribution = await json<{ data: { aggregation_bits: string } }>(
        `${m.beacon}/eth/v1/validator/sync_committee_contribution?slot=${slot}` +
          `&subcommittee_index=${subnet}&beacon_block_root=${header.data.root}`,
      );
      assertFullBitvector(contribution.data.aggregation_bits, 128, `sync contribution ${subnet}`);
      syncContributions.push(contribution);
    }
  }
  const result = {
    nowMs: bn.nowMs,
    block,
    header,
    syncContributions,
    beaconState: { bytes: bytes.length, sha256: await sha256(bytes) },
    el: await rpc<{ hash: string; number: string }>(m.el, "eth_getBlockByNumber", ["latest", true]),
    balance: await rpc(m.el, "eth_getBalance", [account, "latest"]),
    nonce: await rpc(m.el, "eth_getTransactionCount", [account, "latest"]),
    storage: await rpc(m.el, "eth_getStorageAt", [contract, "0x0", "latest"]),
    receipts: await Promise.all(
      hashes.map((hash) => rpc(m.el, "eth_getTransactionReceipt", [hash])),
    ),
    finality: await json<{ data: { finalized: { epoch: string; root: string } } }>(
      `${m.beacon}/eth/v1/beacon/states/head/finality_checkpoints`,
    ),
  };
  if (Number(block.data.message.slot) === 0) {
    // Gloas genesis has no payload envelope; its bid retains the EL genesis parent.
    const bid = block.data.message.body.signed_execution_payload_bid.message;
    assert.equal(BigInt(result.el.number), 0n, "genesis CL head with a non-genesis EL head");
    assert.equal(bid.block_hash, `0x${"00".repeat(32)}`, "genesis bid is not empty");
    assert.equal(bid.parent_block_hash, result.el.hash, "genesis EL/CL disagreement");
  } else {
    assert.equal((await executionAt(m, "head")).block_hash, result.el.hash, "EL/CL disagreement");
  }
  await record(`${evidence}/${name}.json`, result);
  return result;
}

async function continueRun(
  controller: Controller,
  time: Timeline,
  mode: Mode,
  cut: number,
  through: number,
  evidence: string,
  contract: string,
  hashes: string[],
  before: Awaited<ReturnType<typeof state>>,
  skip = false,
) {
  const m = controller.manifest;
  const receipt = await rpc<Receipt | null>(m.el, "eth_getTransactionReceipt", [hashes.at(-1)!]);
  assert(receipt, "first post-restart transaction was not included");
  assert.equal(receipt.status, "0x1");
  assert.equal(receipt.blockHash, (await executionAt(m, "head")).block_hash);
  while (time.slot < through) {
    await time.advanceSlots(Math.min(32, through - time.slot));
    const progress = { cut, through, slot: time.slot, nowMs: time.nowMs };
    await record(`${evidence}/continuation-progress.json`, progress);
    console.log(JSON.stringify({ event: "cold-restart-progress", ...progress }));
  }
  const final = await state(m, evidence, "final", contract, hashes);
  assert.equal(Number(final.block.data.message.slot), through);
  const beacon = await json<{
    execution_optimistic: boolean;
    data: {
      previous_epoch_participation: string[];
      inactivity_scores: string[];
      validators: { slashed: boolean }[];
    };
  }>(`${m.beacon}/eth/v2/debug/beacon/states/head`, {
    headers: { accept: "application/json" },
  });
  assert.equal(beacon.execution_optimistic, false);
  assertFullParticipation(
    beacon.data.previous_epoch_participation,
    beacon.data.inactivity_scores,
    m.config.validators,
  );
  assert(beacon.data.validators.every((validator) => !validator.slashed));
  const epoch = Math.floor(through / 32);
  const rewards = await json<{ data: { total_rewards: AttestationReward[] } }>(
    `${m.beacon}/eth/v1/beacon/rewards/attestations/${epoch - 2}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "[]" },
  );
  assertNoAttestationPenalties(rewards.data.total_rewards, m.config.validators);
  assert(Number(final.finality.data.finalized.epoch) >= epoch - 2, "finality did not resume");
  assert(
    Number(final.finality.data.finalized.epoch) > Number(before.finality.data.finalized.epoch),
    "finality did not advance beyond the saved cut",
  );
  const finalized = await finalizedExecutionHash(m);
  assert.equal(
    (await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["finalized", false])).hash,
    finalized,
    "finalized EL/CL execution disagrees",
  );
  const blocks: Block[] = [];
  for (let slot = cut + 1; slot <= through; slot++) {
    const block = await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/${slot}`);
    assert.equal(Number(block.data.message.slot), slot);
    const body = block.data.message.body;
    // Genesis has no preceding duties. Full coverage begins with votes from real slot 1.
    if ((slot === 1 && cut === 0) || (slot === cut + 1 && skip)) {
      blocks.push(block);
      continue;
    }
    assertFullBitvector(body.sync_aggregate.sync_committee_bits, 512, `sync at ${slot}`);
    const mask = body.payload_attestations.reduce(
      (bits, vote) => bits | BigInt(vote.aggregation_bits),
      0n,
    );
    assertFullBitvector(`0x${mask.toString(16)}`, 512, `PTC at ${slot}`);
    blocks.push(block);
  }
  await record(`${evidence}/continuation-chain.json`, {
    through,
    final,
    receipt,
    finalized,
    rewards,
    blocks,
  });

  // The chain measurements are complete. Stop the signer before copying/exporting any DB.
  const infra = controller.network.infra;
  const clients = await infra.docker.listContainers({
    filters: { label: [`${LABEL}=${m.config.id}`, `${ROLE}=vc`] },
  });
  assert.equal(clients.length, 1);
  const vc = infra.docker.getContainer(clients[0].Id);
  const owned = await vc.inspect();
  assert.equal(owned.Config.Labels?.[LABEL], m.config.id);
  assert.equal(owned.Config.Labels?.[ROLE], "vc");
  await deadline(vc.stop({ t: 30 }), requestTimeoutMs + 5_000, "final VC stop");
  const stopped = await vc.inspect();
  assert.equal(stopped.State.Running, false);
  assert.equal(stopped.State.OOMKilled, false);
  assert.equal(stopped.State.ExitCode, 0);
  const history = await stoppedSigningHistory(
    m,
    `${m.directory}/validator-keys/keys`,
    `${evidence}/signing-final`,
  );
  assert.equal(history.data.length, m.config.validators);
  const savedHistory = mode === "uninterrupted"
    ? undefined
    : await stoppedSigningHistory(m, evidence, `${evidence}/signing-cut`);
  if (savedHistory) {
    assert.equal(savedHistory.data.length, m.config.validators);
    assertSigningHistory(savedHistory);
  }
  assertSigningHistory(history, savedHistory, cut + 1);
  const continued = {
    through,
    final,
    receipt,
    finalized,
    rewards,
    blocks,
    history: retainedSigningHistory(history, through),
  };
  await record(`${evidence}/continuation.json`, continued);
  return continued;
}

async function sample(
  mode: Mode,
  cut: number,
  id: string,
  evidence: string,
  through?: number,
  skip = false,
) {
  await Deno.mkdir(evidence, { recursive: true });
  const controller = await Controller.start({ id, profile: "gloas" });
  const m = controller.manifest;
  let time = controller.time;
  const hashes: string[] = [];
  try {
    const wallet = new Wallet(privateKey);
    const send = async (nonce: number, data: string, to?: string) => {
      const raw = await wallet.signTransaction({
        chainId: m.config.chainId,
        nonce,
        to,
        data,
        gasLimit: 1_000_000n,
        maxFeePerGas: 10_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        type: 2,
      });
      const hash = await rpc<string>(m.el, "eth_sendRawTransaction", [raw]);
      hashes.push(hash);
      return hash;
    };
    // Identical real transactions put nontrivial EL storage and receipts in both branches.
    const contract = getCreateAddress({ from: account, nonce: 0 });
    if (cut !== 0) {
      const deployment = await send(0, "0x6007600c60003960076000f360003560005500");
      await time.stepSlot();
      const deployed = await rpc<Receipt>(m.el, "eth_getTransactionReceipt", [deployment]);
      assert.equal(deployed.status, "0x1");
      assert.equal(deployed.contractAddress?.toLowerCase(), contract.toLowerCase());
      await send(1, `0x${42n.toString(16).padStart(64, "0")}`, contract);
      await time.stepSlot();
      if (skip) await time.skipSlots(cut - time.slot);
      else await time.advanceSlots(cut - time.slot);
    }
    const clock = await json<ClockState>(m.bnClock);
    if (cut > 0) {
      assert.equal(
        clock.marks[skip ? "skip_ready" : "fork_choice"],
        cut,
        "cut must follow completion barriers",
      );
    }
    const before = await state(m, evidence, "before", contract, hashes);
    assert.equal(before.nonce, cut === 0 ? "0x0" : "0x2", "fixture transaction count differs");
    assert.equal(before.storage, `0x${(cut === 0 ? 0n : 42n).toString(16).padStart(64, "0")}`);
    if (mode !== "uninterrupted") {
      assert.equal(before.nowMs - m.config.genesisTime * 1000, cut * 12_000 + 11_500);
      const capture = mode === "replay" || mode === "restore"
        ? controller.network.consensusMessages
        : undefined;
      if (mode === "replay" || mode === "restore") {
        assert(capture, "replay requires capture from network creation");
      }
      // Preflight synchronously refuses pending/ambiguous submissions before stopping clients.
      let captured = capture?.snapshot();
      if (captured) {
        await record(`${evidence}/capture-before-stop.json`, {
          cut,
          nowMs: before.nowMs,
          messages: captured,
        });
      }
      await restartClients(
        controller,
        before.nowMs,
        evidence,
        captured
          ? async (restarted) => {
            // Direct ordinary Beacon API replay bypasses capture; VC is still absent.
            const saved = JSON.parse(
              await Deno.readTextFile(`${evidence}/capture-stopped.json`),
            );
            await replayConsensusMessages(saved.messages, restarted.beacon, cut);
          }
          : undefined,
        capture
          ? async () => {
            // Include anything delivered before VC exited, but never wait past a pending request.
            captured = capture.snapshot();
            await record(`${evidence}/capture-stopped.json`, {
              cut,
              nowMs: before.nowMs,
              messages: captured,
            });
          }
          : undefined,
        mode === "restore" ? "save" : undefined,
      );
      time = await Consensus.connect(m, controller.network.engine, controller.network);
    }
    const sendNext = async () => {
      if (cut === 0) {
        // Deploy storage[0]=99 in the first real block.
        await send(0, "0x60636000556007601160003960076000f360003560005500");
      } else await send(2, `0x${99n.toString(16).padStart(64, "0")}`, contract);
    };
    let sourceNext: Awaited<ReturnType<typeof state>> | undefined;
    if (mode === "restore") {
      const source = await state(m, evidence, "source-resumed", contract, hashes);
      assert.deepEqual(source, before, "saving changed the source before continuation");
      await sendNext();
      await time.stepSlot();
      sourceNext = await state(m, evidence, "source-next", contract, hashes);
      hashes.pop(); // The restored branch resubmits the same transaction against the saved state.
      await restartClients(
        controller,
        before.nowMs,
        evidence,
        async (restarted) => {
          const saved = JSON.parse(await Deno.readTextFile(`${evidence}/capture-stopped.json`));
          await replayConsensusMessages(saved.messages, restarted.beacon, cut);
        },
        undefined,
        "restore",
      );
      time = await Consensus.connect(m, controller.network.engine, controller.network);
    }
    const restored = await state(m, evidence, "restored", contract, hashes);
    assert.deepEqual(restored, before, "cold startup changed saved state before any advancement");
    await sendNext();
    let advanceError: string | undefined;
    try {
      await time.stepSlot();
    } catch (error) {
      // A late-duty timeout must not hide the already produced block's lost PTC/attestations.
      advanceError = String(error);
    }
    const next = await state(m, evidence, "next", contract, hashes);
    if (sourceNext) {
      assert.deepEqual(next, sourceNext, "restored continuation differs from saved source");
    }
    const result = {
      mode,
      cut,
      skip,
      bake: m.bake.tag,
      bakeKey: m.bake.key,
      images: Object.fromEntries(
        Object.entries(m.bake.images).map((
          [role, image],
        ) => [role, { id: image.id, platform: image.platform }]),
      ),
      before,
      restored,
      next,
      advanceError,
      continued: undefined as Awaited<ReturnType<typeof continueRun>> | undefined,
    };
    await record(`${evidence}/result.json`, result);
    if (through !== undefined) {
      try {
        assert.equal(advanceError, undefined, "cannot continue after an incomplete next slot");
        result.continued = await continueRun(
          controller,
          time,
          mode,
          cut,
          through,
          evidence,
          contract,
          hashes,
          before,
          skip,
        );
        await record(`${evidence}/result.json`, result);
      } catch (error) {
        // Never replace the next-block proof or mask the original failure with failed readback.
        try {
          const probes = await Promise.allSettled([
            json<ClockState>(m.bnClock),
            json<ClockState>(m.vcClock),
            json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`),
            rpc(m.el, "eth_getBlockByNumber", ["latest", true]),
            state(m, evidence, "continuation-failure", contract, hashes),
          ]);
          await record(`${evidence}/continuation-error.json`, {
            error: String(error),
            cut,
            through,
            controllerSlot: time.slot,
            controllerNowMs: time.nowMs,
            probes: Object.fromEntries(
              ["bnClock", "vcClock", "block", "execution", "state"].map((name, index) => {
                const probe = probes[index];
                return [
                  name,
                  probe.status === "fulfilled" ? probe.value : { error: String(probe.reason) },
                ];
              }),
            ),
          });
        } catch (readback) {
          console.error(
            JSON.stringify({
              event: "continuation-readback-failed",
              error: String(error),
              readback: String(readback),
            }),
          );
        }
        throw error;
      }
    }
    return result;
  } finally {
    time.stop();
    await controller.close();
  }
}

async function supervised(
  mode: Mode,
  cut: number,
  evidence: string,
  through?: number,
  skip = false,
) {
  const id = `cold-${mode === "uninterrupted" ? "n" : "r"}-${crypto.randomUUID().slice(0, 8)}`;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      import.meta.filename!,
      "--sample",
      mode,
      String(cut),
      id,
      evidence,
      String(through ?? ""),
      ...(skip ? ["--skip"] : []),
    ],
    stdout: "inherit",
    stderr: "inherit",
    env: { PANDA_TIMEOUT_MS: String(requestTimeoutMs) },
  }).spawn();
  let settled = false;
  const finished = child.status.finally(() => {
    settled = true;
  });
  try {
    const status = await deadline(
      finished,
      180_000 + (through ?? cut) * 2_000,
      `cold restart ${mode} at ${cut}`,
    );
    assert(status.success, `${mode} child failed; inspect ${evidence}`);
    return JSON.parse(await Deno.readTextFile(`${evidence}/result.json`)) as Awaited<
      ReturnType<typeof sample>
    >;
  } finally {
    // Stop the process before deleting its exact-owned resources; never race a live producer.
    const terminate = () => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        // The child can exit between the settled check and kill.
        if (
          !(error instanceof Deno.errors.NotFound) &&
          !(error instanceof TypeError && error.message === "Child process has already terminated")
        ) throw error;
      }
    };
    try {
      terminate();
    } finally {
      try {
        await finished;
      } finally {
        await deadline(new Infrastructure(id).cleanup(), 30_000, `${id} test cleanup`);
      }
    }
  }
}

export async function runColdRestart(
  cuts = [3],
  referencePath?: string,
  replay = false,
  through?: number,
  copyDatabases = false,
  skip = false,
) {
  assert(
    cuts.length > 0 &&
      cuts.every((cut) => Number.isSafeInteger(cut) && (cut === 0 || cut >= 3) && cut <= 128),
  );
  if (skip) assert(cuts.every((cut) => cut >= 35), "sparse cuts must skip at least an epoch");
  if (through !== undefined) {
    assert(
      Number.isSafeInteger(through) && through <= 4096 && cuts.every((cut) => through >= cut + 96),
      "continuation must cover at least 96 slots beyond every cut and end by slot 4096",
    );
  }
  const evidence = `.cache/snapshot-cold-restart/${crypto.randomUUID()}`;
  let reference: Awaited<ReturnType<typeof sample>> | undefined;
  if (referencePath) {
    assert.equal(cuts.length, 1, "one saved reference can cover only its original cut");
    const bytes = await Deno.readTextFile(referencePath);
    reference = JSON.parse(bytes) as Awaited<ReturnType<typeof sample>>;
    const bake = await readBake("gloas", Deno.env.get("PANDA_BAKE") ?? "default");
    assert.equal(reference.mode, "uninterrupted", "reference must be an uninterrupted sample");
    assert.equal(reference.cut, cuts[0], "reference cut differs");
    assert.equal(reference.skip ?? false, skip, "reference slot history differs");
    assert.equal(reference.bake, bake.tag, "reference bake differs");
    assert.equal(reference.bakeKey, bake.key, "reference bake key differs");
    assert.deepEqual(
      reference.images,
      Object.fromEntries(
        Object.entries(bake.images).map((
          [role, image],
        ) => [role, { id: image.id, platform: image.platform }]),
      ),
      "reference image identities differ",
    );
    assert.equal(reference.advanceError, undefined, "cannot reuse a failed reference advance");
    assert.equal(Number(reference.next.block.data.message.slot), cuts[0] + 1);
    assert.equal(reference.next.nowMs, reference.before.nowMs + 12_000);
    assert.deepEqual(reference.restored, reference.before);
    if (through !== undefined) {
      assert.equal(
        reference.continued?.through,
        through,
        "reference lacks the requested continuation",
      );
      assert.equal(Number(reference.continued.final.block.data.message.slot), through);
    }
    const reused = {
      path: referencePath,
      sha256: await sha256(bytes),
      cut: cuts[0],
      bakeKey: bake.key,
    };
    await record(`${evidence}/reference-reuse.json`, reused);
    console.log(JSON.stringify({ event: "cold-restart-reference-reused", evidence, ...reused }));
  }
  const failures: string[] = [];
  for (const cut of cuts) {
    const uninterrupted = reference ?? await supervised(
      "uninterrupted",
      cut,
      `${evidence}/${cut}/uninterrupted`,
      through,
      skip,
    );
    const mode = copyDatabases ? "restore" : replay ? "replay" : "cold";
    const cold = await supervised(mode, cut, `${evidence}/${cut}/${mode}`, through, skip);
    const compare = (name: string, actual: unknown, expected: unknown) => {
      try {
        assert.deepEqual(actual, expected);
      } catch {
        failures.push(`slot ${cut}: ${name}`);
      }
    };
    compare("bake identity", cold.bakeKey, uninterrupted.bakeKey);
    compare("independent original state", cold.before, uninterrupted.before);
    compare("complete signed next block", cold.next.block, uninterrupted.next.block);
    compare("complete next state and execution", cold.next, uninterrupted.next);
    if (through !== undefined) {
      compare(
        "continued chain, economics, finality and signing history",
        cold.continued,
        uninterrupted.continued,
      );
    }
    if (uninterrupted.advanceError) {
      failures.push(`slot ${cut}: reference ${uninterrupted.advanceError}`);
    }
    if (cold.advanceError) failures.push(`slot ${cut}: cold ${cold.advanceError}`);
    const body = (branch: typeof cold) => branch.next.block.data.message.body;
    await record(`${evidence}/${cut}/comparison.json`, {
      cut,
      mode,
      through,
      bakeKey: cold.bakeKey,
      failures,
      uninterrupted: body(uninterrupted),
      cold: body(cold),
    });
    console.log(JSON.stringify({ event: "cold-restart-compared", mode, cut, evidence, failures }));
  }
  assert.equal(
    failures.length,
    0,
    `Cold restart changed real continuation: ${failures.join("; ")}`,
  );
}

if (import.meta.main) {
  if (Deno.args[0] === "--sample") {
    const [, mode, cut, id, evidence, through, skip] = Deno.args;
    assert(["cold", "uninterrupted", "replay", "restore"].includes(mode));
    await sample(
      mode as Mode,
      Number(cut),
      id,
      evidence,
      through ? Number(through) : undefined,
      skip === "--skip",
    );
  } else {
    const args = [...Deno.args];
    let reference: string | undefined;
    let replay = false;
    let copyDatabases = false;
    let skip = false;
    let through: number | undefined;
    while (args[0]?.startsWith("--")) {
      const flag = args.shift();
      if (flag === "--replay") replay = true;
      else if (flag === "--restore") copyDatabases = true;
      else if (flag === "--skip") skip = true;
      else if (flag === "--through") {
        const value = args.shift();
        assert(value && /^\d+$/.test(value), "--through requires a final slot");
        through = Number(value);
      } else if (flag === "--reference") {
        reference = args.shift();
        assert(reference, "--reference requires an uninterrupted result.json path");
      } else throw new Error(`Unknown option: ${flag}`);
    }
    await runColdRestart(
      args.length ? args.map(Number) : [3],
      reference,
      replay,
      through,
      copyDatabases,
      skip,
    );
  }
}
