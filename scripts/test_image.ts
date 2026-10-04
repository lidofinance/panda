import assert from "node:assert/strict";
import { request } from "node:http";
import { JsonRpcProvider, Wallet } from "ethers";
import { Devnet } from "../src/api.ts";
import { account, privateKey } from "../src/config.ts";
import { GENERATION, Infrastructure, LABEL, ROLE } from "../src/docker.ts";
import { deadline, delay, json, waitFor } from "../src/http.ts";
import { atomicJson } from "../src/artifacts.ts";
import { bakePath, legacyBakePath, profileName } from "../src/profiles.ts";

const [image, profile] = Deno.args;
if (!image || !profile) throw new Error("Usage: test_image.ts <image> <profile>");
const id = `image-${crypto.randomUUID().slice(0, 8)}`;
const infra = new Infrastructure(id);
const ports = [8545, 5052, 5062];
// Explicit host ports remain identical across both restart and container replacement.
const listeners = ports.map(() => Deno.listen({ hostname: "127.0.0.1", port: 0 }));
const published = listeners.map((listener) => listener.addr.port);
for (const listener of listeners) listener.close();
const dataVolume = await infra.volume("data");
const createContainer = () =>
  infra.container("service", {
    Image: image,
    ExposedPorts: Object.fromEntries(ports.map((port) => [`${port}/tcp`, {}])),
    HostConfig: {
      Privileged: true,
      Binds: [`${dataVolume}:/data/panda`],
      PortBindings: Object.fromEntries(ports.map((port, index) => [
        `${port}/tcp`,
        [{ HostIp: "127.0.0.1", HostPort: String(published[index]) }],
      ])),
    },
  });
let container = await createContainer().catch(async (error) => {
  await infra.cleanup();
  throw error;
});
let provider: JsonRpcProvider | undefined;
const started = performance.now();
const evidence: Record<string, unknown> = { image, profile, id, passed: false };
// Exercise SIGTERM while a real startup job is unfinished, before testing ready-service restarts.
async function interruptStartup() {
  await container.start();
  const before = await container.inspect();
  const inner = (args: string[]) => infra.exec(container, ["docker", ...args]);
  const inspect = async (client: string) =>
    JSON.parse(await inner(["inspect", "--format", "{{json .}}", client]));
  let genesis: string | undefined;
  try {
    genesis = await waitFor("packaged genesis startup", async () => {
      const clients = (await inner([
        "ps",
        "--no-trunc",
        "--quiet",
        "--filter",
        `label=${LABEL}=service`,
        "--filter",
        `label=${ROLE}=genesis`,
      ])).trim();
      return clients || undefined;
    }, 300_000);
    assert.match(genesis, /^[a-f0-9]{64}$/, "expected exactly one genesis container");
    const original = await inspect(genesis);
    assert.equal(original.Config.Labels[LABEL], "service");
    assert.equal(original.Config.Labels[ROLE], "genesis");
    assert.equal(original.State.Running, true);
    await inner(["pause", genesis]);
    const paused = await inspect(genesis);
    assert.equal(paused.Config.Labels[LABEL], "service");
    assert.equal(paused.Config.Labels[ROLE], "genesis");
    assert.equal(paused.State.Paused, true, "startup job must actually be unfinished");
    const generation = paused.Config.Labels[GENERATION];
    assert.equal(typeof generation, "string");
    assert.match(generation, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    const interruptedAt = performance.now();
    await container.stop({ t: 30 });
    const state = (await container.inspect()).State;
    assert.equal(state.Running, false);
    assert.equal(state.OOMKilled, false);
    assert.notEqual(state.ExitCode, 137, "startup ignored SIGTERM and needed SIGKILL");
    assert.notEqual(state.ExitCode, 143, "startup exited before orderly cleanup");
    assert.doesNotMatch(await infra.logs(container), /"event":"ready"/);
    return {
      containerId: before.Id,
      ports: before.NetworkSettings.Ports,
      genesisId: genesis,
      generation: generation as string,
      exitCode: state.ExitCode,
      elapsedMs: performance.now() - interruptedAt,
    };
  } finally {
    // A failed assertion must not leave our deliberately paused fixture running.
    if (genesis && (await container.inspect()).State.Running) {
      const remaining = await inspect(genesis).catch(() => undefined);
      if (remaining) {
        assert.equal(remaining.Config.Labels[LABEL], "service");
        assert.equal(remaining.Config.Labels[ROLE], "genesis");
        await inner(["rm", "--force", "--volumes", genesis]);
      }
    }
  }
}
async function saveClientLogs(): Promise<void> {
  await Deno.mkdir(".cache/container-reports", { recursive: true });
  const errors: unknown[] = [];
  for (const role of ["el", "cl", "vc"]) {
    try {
      const logs = await infra.exec(container, ["panda", "logs", role, "--tail", "2000"]);
      assert.ok(logs.trim().length > 0, `Missing ${role} logs`);
      await Deno.writeTextFile(`.cache/container-reports/${profile}-${id}-${role}.log`, logs);
    } catch (error) {
      errors.push(new Error(`${role} logs: ${error}`));
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
}
try {
  const interrupted = await interruptStartup();
  evidence.interruptedStartup = interrupted;
  await container.start();
  const running = await container.inspect();
  assert.equal(running.Id, interrupted.containerId);
  assert.deepEqual(running.NetworkSettings.Ports, interrupted.ports);
  assert.equal(
    running.Mounts.find((mount) => mount.Destination === "/data/panda")?.Name,
    dataVolume,
  );
  evidence.imageId = running.Image;
  const endpoint = (port: number) =>
    `http://127.0.0.1:${running.NetworkSettings.Ports[`${port}/tcp`]![0].HostPort}`;
  const url = endpoint(8545);
  const beacon = endpoint(5052);
  const validator = endpoint(5062);
  const net = new Devnet(url);
  const ready = async () => {
    const expiresAt = performance.now() + 300_000;
    while (performance.now() < expiresAt) {
      if (!(await container.inspect()).State.Running) {
        throw new Error("Service exited during startup");
      }
      const status = await deadline(net.status(), 8000, "packaged status probe").catch(() =>
        undefined
      );
      if (status) return status;
      await delay(250);
    }
    throw new Error("Packaged Panda readiness timed out");
  };
  const initial = await ready();
  const generation = (await net.lifecycle()).generation;
  assert.equal(typeof generation, "string");
  assert.match(generation!, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.notEqual(generation, interrupted.generation);
  assert.ok(
    !(await infra.exec(container, [
      "docker",
      "ps",
      "--all",
      "--no-trunc",
      "--quiet",
      "--filter",
      `label=${LABEL}=service`,
    ])).split(/\s+/).includes(interrupted.genesisId),
    "interrupted genesis was not removed",
  );
  const packaged = JSON.parse(await infra.exec(container, ["cat", "/opt/panda/release.json"]));
  assert.equal(packaged.profile, profile);
  const manifest = JSON.parse(
    await infra.exec(container, [
      "cat",
      `/opt/panda/${bakePath(profileName(profile), packaged.bake)}`,
    ]).catch(() =>
      infra.exec(container, [
        "cat",
        `/opt/panda/${legacyBakePath(profileName(profile), packaged.bake)}`,
      ])
    ),
  );
  const checkpointCapable = manifest.recipe.checkpointAbi === 1;
  // Derive capability from the packaged immutable bake. A broken lifecycle endpoint must fail,
  // rather than silently downgrade a checkpoint-capable image to the historical test branch.
  if (checkpointCapable) assert.equal((await net.lifecycle()).checkpointCapable, true);
  assert.equal(initial.profile, profile);
  assert.equal(BigInt(initial.el.number), 0n);
  assert.equal(initial.slot, 0);
  assert.equal(initial.automine, false);
  evidence.initial = initial;
  // Exercise the real health command repeatedly: a readiness probe must never mine.
  for (let i = 0; i < 2; i++) {
    await infra.exec(container, [
      "deno",
      "run",
      "--config=deno.json",
      "--cached-only",
      "-A",
      "container/health.ts",
    ]);
  }
  assert.equal((await net.status()).el.hash, initial.el.hash);
  assert.equal((await net.status()).slot, 0);
  assert.deepEqual(
    await json(`${beacon}/eth/v1/beacon/genesis`),
    await json(`${url}/eth/v1/beacon/genesis`),
  );
  for (const [token, expected] of [[undefined, 401], ["invalid-token", 403]] as const) {
    const denied = await fetch(`${validator}/eth/v1/keystores`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(denied.status, expected);
    await denied.body?.cancel();
  }
  const token = (await infra.exec(container, ["panda", "validator-token"])).trim();
  assert.ok(token.length > 16, "Missing VC token");
  const keys = () =>
    json<{ data: { validating_pubkey: string }[] }>(
      `${validator}/eth/v1/keystores`,
      { headers: { authorization: `Bearer ${token}`, connection: "close" } },
    );
  const publicKeys = async () => (await keys()).data.map((key) => key.validating_pubkey).sort();
  const validators = await publicKeys();
  assert.ok(validators.length > 0, "Native VC API must expose the actual genesis validators");
  // fetch normalizes Host; use an HTTP request that can send an actual foreign Host.
  const denied = await new Promise<number>((resolve, reject) => {
    const req = request(`${url}/control`, {
      method: "POST",
      headers: { host: "external.example", connection: "close" },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode!));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Host probe timed out")));
    req.end(JSON.stringify({ method: "status" }));
  });
  assert.equal(denied, 403);
  assert.equal(
    (await infra.docker.listContainers({ filters: { label: [`${LABEL}=${initial.id}`] } })).length,
    0,
    "Inner clients must not be created on the host daemon",
  );
  await net.advanceSlots(1);
  await net.setAutomine(true);
  provider = new JsonRpcProvider(url);
  const tx = await new Wallet(privateKey, provider).sendTransaction({
    to: "0x0000000000000000000000000000000000000001",
    value: 1n,
  });
  const receipt = await waitFor(
    "packaged transaction",
    async () => (await provider!.getTransactionReceipt(tx.hash)) ?? undefined,
    60_000,
  );
  assert.equal(receipt.status, 1);
  await net.setAutomine(false);
  const paused = await net.status();
  await delay(1000);
  assert.equal((await net.status()).el.hash, paused.el.hash);
  evidence.transaction = tx.hash;
  if (checkpointCapable) {
    const before = await net.lifecycle();
    const checkpoint = await net.stop();
    assert.equal(checkpoint.nowMs, paused.now * 1000);
    assert.equal(checkpoint.headSlot, paused.slot);
    assert.equal((await net.lifecycle()).ready, false);
    for (
      const endpoint of [
        `${beacon}/eth/v1/beacon/headers/head`,
        `${validator}/eth/v1/keystores`,
      ]
    ) {
      const unavailable = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
      assert.equal(unavailable.status, 503, "parked clients must remain behind the managed gate");
      await unavailable.body?.cancel();
    }
    await net.resume();
    const resumed = await net.status();
    assert.equal(resumed.now, paused.now);
    assert.equal(resumed.slot, paused.slot);
    assert.deepEqual(resumed.el, paused.el);
    assert.deepEqual(resumed.finality, paused.finality);
    const after = await net.lifecycle();
    assert.equal(after.generation, before.generation);
    assert.notEqual(after.sessionId, before.sessionId);
    assert.deepEqual(await publicKeys(), validators);
    evidence.managedStopResume = {
      generation: after.generation,
      before: before.sessionId,
      after: after.sessionId,
    };
  }
  // Fast mode replaces VC and its internal port; the public port and token must still work.
  await net.advanceTime(64 * 12, { mode: "fast" });
  assert.deepEqual(await publicKeys(), validators);
  const final = await net.status();
  assert.equal(final.slot, paused.slot + 64);
  const head = await json<{ data: { header: { message: { slot: string } } } }>(
    `${beacon}/eth/v1/beacon/headers/head`,
  );
  assert.equal(Number(head.data.header.message.slot), final.slot);
  evidence.final = final;
  evidence.clientAccess = { beacon: true, validator: true, validatorAfterFastWarp: true };
  await saveClientLogs();
  provider.destroy();
  provider = undefined;
  const stopService = async () => {
    // GitHub Actions/Docker delivers SIGTERM; exceeding this budget must fail the test.
    await container.stop({ t: 120 });
    const stopped = (await container.inspect()).State;
    assert.equal(stopped.Running, false);
    assert.equal(stopped.OOMKilled, false);
    assert.equal(stopped.ExitCode, 0, "service must preserve its checkpoint without force-kill");
  };
  const beaconHead = async () => {
    const header = await json<
      { data: { root: string; header: { message: { slot: string; state_root: string } } } }
    >(`${beacon}/eth/v1/beacon/headers/head`);
    return {
      root: header.data.root,
      stateRoot: header.data.header.message.state_root,
      slot: Number(header.data.header.message.slot),
    };
  };
  const checkRestart = async (
    saved: Awaited<ReturnType<Devnet["status"]>>,
    sessionId: string,
    generation: string,
    savedHead: Awaited<ReturnType<typeof beaconHead>>,
  ) => {
    await container.start();
    const inspected = await container.inspect();
    assert.equal(inspected.Id, running.Id, "test must restart the same service container");
    assert.deepEqual(inspected.NetworkSettings.Ports, running.NetworkSettings.Ports);
    assert.equal(
      inspected.Mounts.find((mount) => mount.Destination === "/data/panda")?.Name,
      dataVolume,
    );
    const resumed = await ready();
    assert.equal(resumed.now, saved.now, "restart moved protocol time");
    assert.equal(resumed.slot, saved.slot, "restart moved the slot");
    assert.deepEqual(resumed.el, saved.el, "restart changed execution head");
    assert.deepEqual(resumed.finality, saved.finality, "restart changed finality");
    assert.equal(resumed.automine, false);
    const current = await net.lifecycle();
    assert.equal(current.generation, generation);
    assert.notEqual(current.sessionId, sessionId);
    const head = await beaconHead();
    assert.deepEqual(head, savedHead, "restart changed the native Beacon head or state root");
    assert.equal(head.slot, saved.slot);
    assert.equal((await infra.exec(container, ["panda", "validator-token"])).trim(), token);
    assert.deepEqual(await publicKeys(), validators);
    await infra.exec(container, [
      "deno",
      "run",
      "--config=deno.json",
      "--cached-only",
      "-A",
      "container/health.ts",
    ]);
    return { status: resumed, lifecycle: current, head };
  };
  if (checkpointCapable) {
    const before = await net.lifecycle();
    const savedHead = await beaconHead();
    await stopService();
    const resumed = await checkRestart(final, before.sessionId, before.generation!, savedHead);
    provider = new JsonRpcProvider(url);
    await net.setAutomine(true);
    const nextTx = await new Wallet(privateKey, provider).sendTransaction({
      to: "0x0000000000000000000000000000000000000001",
      value: 2n,
    });
    const nextReceipt = await waitFor(
      "post-restart packaged transaction",
      async () => (await provider!.getTransactionReceipt(nextTx.hash)) ?? undefined,
      60_000,
    );
    assert.equal(nextReceipt.status, 1);
    await net.setAutomine(false);
    provider.destroy();
    provider = undefined;
    await net.advanceEpochs(4);
    const continued = await net.status();
    assert(
      Number(continued.finality.data.finalized.epoch) >= Math.floor(continued.slot / 32) - 2,
      "finality did not resume after packaged restart",
    );
    const finalized = await json<{
      execution_optimistic: boolean;
      data: {
        message: {
          body: {
            execution_payload?: { block_hash: string };
            signed_execution_payload_bid?: { message: { parent_block_hash: string } };
          };
        };
      };
    }>(`${beacon}/eth/v2/beacon/blocks/finalized`);
    assert.equal(finalized.execution_optimistic, false);
    const finalizedHash = profile === "gloas"
      ? finalized.data.message.body.signed_execution_payload_bid?.message.parent_block_hash
      : finalized.data.message.body.execution_payload?.block_hash;
    assert(finalizedHash, "missing finalized execution reference");
    assert.equal(
      (await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false])).hash,
      finalizedHash,
    );
    await saveClientLogs();
    // A second SIGTERM must accept a checkpoint already saved by the SDK stop operation.
    const beforeStopped = await net.lifecycle();
    const stoppedCheckpoint = await net.stop();
    assert.equal(stoppedCheckpoint.nowMs, continued.now * 1000);
    assert.equal(stoppedCheckpoint.headSlot, continued.slot);
    await stopService();
    const stoppedResume = await checkRestart(
      continued,
      beforeStopped.sessionId,
      beforeStopped.generation!,
      {
        root: stoppedCheckpoint.headBlockRoot,
        stateRoot: stoppedCheckpoint.headStateRoot,
        slot: stoppedCheckpoint.headSlot,
      },
    );
    evidence.persistence = {
      volume: dataVolume,
      firstRestart: resumed,
      nextTransaction: nextTx.hash,
      nextReceipt: {
        status: nextReceipt.status,
        blockHash: nextReceipt.blockHash,
        blockNumber: nextReceipt.blockNumber,
      },
      finalizedExecutionHash: finalizedHash,
      stoppedCheckpoint,
      afterSdkStopAndSigterm: stoppedResume,
    };

    // A snapshot must outlive the whole private Docker daemon, not only its controller process.
    // Capture expectations independently, then make and abandon an actually included future.
    const saved = await net.status();
    console.log(JSON.stringify({ event: "packaged-snapshot-create", slot: saved.slot }));
    const savedNativeHead = await beaconHead();
    const savedReceipt = await net.rpc("eth_getTransactionReceipt", [nextTx.hash]);
    const savedBalance = await net.rpc("eth_getBalance", [account, "latest"]);
    const savedNonce = await net.rpc("eth_getTransactionCount", [account, "latest"]);
    const createId = crypto.randomUUID();
    const snapshot = await net.createSnapshot({ operationId: createId });
    const source = await net.lifecycle();
    const send = async (value: bigint) => {
      // Fresh RPC nonce on each branch; no provider state can leak across restore.
      const raw = await new Wallet(privateKey).signTransaction({
        type: 2,
        chainId: 1337,
        nonce: Number(
          BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "latest"])),
        ),
        to: account,
        gasLimit: 21_000,
        maxFeePerGas: 10_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        value,
      });
      const started = performance.now();
      await net.setAutomine(true);
      const hash = await net.rpc<string>("eth_sendRawTransaction", [raw]);
      const receipt = await waitFor(
        "packaged snapshot transaction",
        async () =>
          await net.rpc<{ status: string; blockHash: string } | null>(
            "eth_getTransactionReceipt",
            [hash],
          ) ?? undefined,
        60_000,
      );
      await net.setAutomine(false);
      assert.equal(receipt.status, "0x1");
      return { hash, receipt, elapsedMs: performance.now() - started };
    };
    const discarded = await send(3n);
    const future = await net.status();
    assert(future.slot > saved.slot);
    assert.notEqual(future.el.hash, saved.el.hash);
    await saveClientLogs();
    await Deno.writeTextFile(
      `.cache/container-reports/${profile}-${id}-before-loss.log`,
      await infra.logs(container),
    );
    const lost = await container.inspect();
    assert.equal(lost.Config.Labels[LABEL], id);
    await container.kill({ signal: "SIGKILL" });
    await container.wait();
    const killed = (await container.inspect()).State;
    assert.equal(killed.Running, false);
    assert.equal(killed.ExitCode, 137);
    assert.equal(killed.OOMKilled, false);
    // v removes anonymous private-Docker storage; the explicitly named /data/panda survives.
    await container.remove({ v: true });
    assert.equal((await infra.docker.getVolume(dataVolume).inspect()).Labels[LABEL], id);
    container = await createContainer();
    await container.start();
    const replacement = await container.inspect();
    assert.notEqual(replacement.Id, lost.Id);
    assert.equal(replacement.Image, running.Image);
    assert.deepEqual(replacement.NetworkSettings.Ports, running.NetworkSettings.Ports);
    assert.equal(
      replacement.Mounts.find((mount) => mount.Destination === "/data/panda")?.Name,
      dataVolume,
    );
    const recovery = await waitFor(
      "packaged recovery service",
      async () => await deadline(net.lifecycle(), 8000, "packaged recovery probe"),
      300_000,
    );
    assert.equal(recovery.ready, false);
    assert.equal(recovery.recoveryRequired, true);
    assert.equal(recovery.generation, source.generation);
    assert.equal(recovery.now, undefined, "unclean data cannot claim a current protocol time");
    assert.equal(recovery.slot, undefined);
    console.log(JSON.stringify({ event: "packaged-snapshot-recovery-required" }));
    await assert.rejects(() => deadline(net.status(), 8000, "unclean packaged status"));
    await assert.rejects(() =>
      infra.exec(container, [
        "deno",
        "run",
        "--config=deno.json",
        "--cached-only",
        "-A",
        "container/health.ts",
      ])
    );
    for (const endpoint of [beacon, validator]) {
      const response = await fetch(`${endpoint}/eth/v1/beacon/headers/head`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 503);
      await response.body?.cancel();
    }
    assert.equal(
      (await infra.exec(container, [
        "docker",
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=${LABEL}=service`,
      ])).trim(),
      "",
      "recovery must not start clients or regenerate genesis",
    );
    assert.deepEqual(await net.listSnapshots(), [snapshot]);
    assert.equal((await net.snapshotOperation(createId))?.state, "succeeded");
    const restoreId = crypto.randomUUID();
    const restoreStarted = performance.now();
    const restored = await net.restoreSnapshot(snapshot, { operationId: restoreId });
    const restoreMs = performance.now() - restoreStarted;
    const restoredStatus = await net.status();
    assert.equal(restoredStatus.now, saved.now);
    assert.equal(restoredStatus.slot, saved.slot);
    assert.equal(restoredStatus.automine, false);
    assert.deepEqual(restoredStatus.el, saved.el);
    assert.deepEqual(restoredStatus.finality, saved.finality);
    assert.deepEqual(await beaconHead(), savedNativeHead);
    assert.deepEqual(await net.rpc("eth_getTransactionReceipt", [nextTx.hash]), savedReceipt);
    assert.equal(await net.rpc("eth_getTransactionReceipt", [discarded.hash]), null);
    assert.equal(await net.rpc("eth_getBalance", [account, "latest"]), savedBalance);
    assert.equal(await net.rpc("eth_getTransactionCount", [account, "latest"]), savedNonce);
    const restoredLifecycle = await net.lifecycle();
    assert.equal(restoredLifecycle.ready, true);
    assert.notEqual(restoredLifecycle.generation, source.generation);
    assert.notEqual(restoredLifecycle.sessionId, source.sessionId);
    const restoreOperation = await net.snapshotOperation(restoreId);
    assert.equal(restoreOperation?.cleanup?.state, "succeeded", restoreOperation?.cleanup?.error);
    assert.deepEqual(await net.restoreSnapshot(snapshot, { operationId: restoreId }), restored);
    assert.deepEqual(await publicKeys(), validators);
    const next = await send(4n);
    console.log(JSON.stringify({ event: "packaged-snapshot-restored", restoreMs }));
    assert.notEqual(next.hash, discarded.hash);
    await net.advanceEpochs(4);
    const afterRestore = await net.status();
    assert(
      Number(afterRestore.finality.data.finalized.epoch) >
        Number(saved.finality.data.finalized.epoch),
      "finality must advance on the restored branch",
    );
    const finalizedAfterRestore = await net.beacon<typeof finalized>(
      "/eth/v2/beacon/blocks/finalized",
    );
    assert.equal(finalizedAfterRestore.execution_optimistic, false);
    const executionAfterRestore = profile === "gloas"
      ? finalizedAfterRestore.data.message.body.signed_execution_payload_bid?.message
        .parent_block_hash
      : finalizedAfterRestore.data.message.body.execution_payload?.block_hash;
    assert(executionAfterRestore);
    assert.equal(
      (await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false])).hash,
      executionAfterRestore,
    );
    await saveClientLogs();
    evidence.snapshotRecovery = {
      snapshot,
      source,
      future,
      discarded,
      lostContainer: lost.Id,
      replacementContainer: replacement.Id,
      recovery,
      restored,
      restoreMs,
      restoredStatus,
      restoredLifecycle,
      next,
      continued: afterRestore,
      finalizedExecutionHash: executionAfterRestore,
    };
  }
  await stopService();
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  await saveClientLogs().catch((logsError) => evidence.logsError = String(logsError));
  throw error;
} finally {
  provider?.destroy();
  evidence.elapsedMs = performance.now() - started;
  try {
    await Deno.mkdir(".cache/container-reports", { recursive: true });
    await Deno.writeTextFile(
      `.cache/container-reports/${profile}-${id}.log`,
      await infra.logs(container),
    );
    await atomicJson(`.cache/container-reports/${profile}-${id}.json`, evidence);
  } finally {
    await infra.cleanup();
  }
}
console.log(JSON.stringify(evidence));
