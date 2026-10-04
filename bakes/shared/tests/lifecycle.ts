import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { configuration } from "../../../src/config.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { deadline, waitFor } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { profileReport } from "./report.ts";
import { readBake } from "../../../src/profiles.ts";
import { stateDirectory } from "../../../src/storage.ts";

const id = `lifecycle-${crypto.randomUUID().slice(0, 8)}`;
const env = { PANDA_ID: id, PANDA_PORT: "0" };
const infra = new Infrastructure(id);
const directory = stateDirectory(id);
const config = configuration();
const bake = await readBake(config.profile, config.bake);
const command = (task: string, arguments_: string[] = []) =>
  new Deno.Command(Deno.execPath(), {
    // The child PID must be the owning CLI, not a `deno task` wrapper.
    args: ["run", "--config=deno.json", "-A", "src/cli.ts", task, ...arguments_],
    env,
    stdout: "piped",
    stderr: "piped",
  });
let child: Deno.ChildProcess | undefined;
let output: Promise<Deno.CommandOutput> | undefined;
let exited = true;
const start = async (task: string) => {
  assert(exited, "Previous CLI owner is still alive");
  child = command(task).spawn();
  exited = false;
  output = child.output().then((result) => {
    exited = true;
    return result;
  });
  return await waitFor("CLI ready", async () => {
    const endpoint = JSON.parse(await Deno.readTextFile(`${directory}/controller.json`));
    if (endpoint.pid !== child!.pid) return;
    const net = new Devnet(endpoint.url);
    const status = await net.lifecycle();
    return status.id === id && status.ready ? net : undefined;
  }, 120_000);
};
const run = async (task: string) => {
  const result = await command(task).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
};
const finish = async () => {
  const result = await deadline(output!, 30_000, "owning CLI exit");
  assert(result.success, new TextDecoder().decode(result.stderr));
};
const killOwner = async () => {
  assert(child && !exited, "Only this test's live owning CLI may be killed");
  child.kill("SIGKILL");
  const result = await deadline(output!, 30_000, "killed owning CLI exit");
  assert(!result.success);
};
const anchors = async (net: Devnet) => {
  const status = await net.status();
  const header = await net.beacon<{ data: unknown }>("/eth/v1/beacon/headers/head");
  return {
    now: status.now,
    slot: status.slot,
    executionHash: status.el.hash,
    executionNumber: status.el.number,
    header: header.data,
    finality: status.finality,
  };
};
const empty = async () => {
  const filters = { label: [`${LABEL}=${id}`] };
  assert.equal((await infra.docker.listContainers({ all: true, filters })).length, 0);
  assert.equal((await infra.docker.listNetworks({ filters })).length, 0);
  assert.equal((await infra.docker.listVolumes({ filters })).Volumes?.length ?? 0, 0);
};
const started = performance.now();
let managedLifecycle: Record<string, unknown> | undefined;
try {
  const first = await start("up");
  const genesis = (await first.status()).el.hash;
  assert((await run("up")).includes("already-running"));
  const running = await first.status();
  const incompatible = await command("up", [
    "--profile",
    running.profile === "pectra" ? "gloas" : "pectra",
  ]).output();
  assert(!incompatible.success);
  assert(new TextDecoder().decode(incompatible.stderr).includes("requested"));
  await assert.rejects(new Network(configuration({ id })).start(), /owned by live process/);
  const borrowed = new Devnet(first.url);
  await borrowed.close();
  assert.equal((await first.lifecycle()).ready, true, "Borrowed close stopped the shared CLI");
  // This is a storage-layout sentinel, not a snapshot artifact (the snapshot API is P4).
  const snapshotSentinel = `${directory}/snapshots/lifecycle-sentinel`;
  await Deno.writeTextFile(snapshotSentinel, "owned snapshot directory survives down/reset");
  await first.advanceSlots(3);
  if (bake.recipe.checkpointAbi === 1) {
    const before = await anchors(first);
    const session = (await first.lifecycle()).sessionId;
    await run("stop");
    assert.equal((await first.lifecycle()).phase, "parked");
    assert.equal((await first.lifecycle()).ready, false);
    assert((await run("up")).includes("already-running"), "Parked service lost CLI ownership");
    await assert.rejects(first.stepSlot(), /parked/);
    await empty();
    await run("resume");
    assert.deepEqual(await anchors(first), before, "CLI resume changed saved anchors");
    assert.notEqual((await first.lifecycle()).sessionId, session);
    await first.stepSlot();

    const saved = await anchors(first);
    const priorSession = (await first.lifecycle()).sessionId;
    await run("stop");
    await empty();
    assert.equal(JSON.parse(await Deno.readTextFile(`${directory}/active.json`)).phase, "stopped");
    // All real clients are already cleanly stopped. Kill only the remaining owning CLI service.
    await killOwner();
    const reopened = await start("open");
    assert.deepEqual(await anchors(reopened), saved, "CLI open changed the preserved network");
    assert.notEqual((await reopened.lifecycle()).sessionId, priorSession);
    await reopened.stepSlot();
    assert.equal((await reopened.status()).slot, saved.slot + 1);
    managedLifecycle = {
      stableServiceStopResume: true,
      parkedAlreadyRunning: true,
      persistedOpen: true,
      saved,
      nextSlot: saved.slot + 1,
    };
  }
  await run("down");
  await finish();
  await empty();
  assert.equal(
    await Deno.readTextFile(snapshotSentinel),
    "owned snapshot directory survives down/reset",
  );
  await run("down");
  const second = await start("reset");
  assert.equal((await second.status()).el.hash, genesis, "genesis changed on reset");
  assert.equal((await second.status()).slot, 0);
  await second.stepSlot();
  if (bake.recipe.checkpointAbi === 1) {
    const active = await Deno.readTextFile(`${directory}/active.json`);
    const filters = { label: [`${LABEL}=${id}`] };
    const clients = (await infra.docker.listContainers({ all: true, filters })).map((c) => c.Id)
      .sort();
    await killOwner();
    const rejected = await command("open").output();
    assert(!rejected.success, "An unclean active generation was reopened");
    assert.match(
      new TextDecoder().decode(rejected.stderr),
      /unclean or lacks a verified checkpoint/,
    );
    assert.equal(
      await Deno.readTextFile(`${directory}/active.json`),
      active,
      "Open replaced unclean state",
    );
    assert.deepEqual(
      (await infra.docker.listContainers({ all: true, filters })).map((c) => c.Id).sort(),
      clients,
      "Refused open replaced clients with fresh genesis",
    );
    managedLifecycle!.uncleanOpenRefused = true;
  }
  await run("down");
  if (!managedLifecycle) await finish();
  await empty();
  assert.equal(
    await Deno.readTextFile(snapshotSentinel),
    "owned snapshot directory survives down/reset",
  );
  const report = {
    event: "lifecycle-passed",
    elapsedMs: performance.now() - started,
    repeatedUp: true,
    repeatedDown: true,
    resetGenesis: genesis,
    duplicateOwnerRejected: true,
    differentProfileRejected: true,
    borrowedClosePreservesService: true,
    snapshotDirectoryPreserved: true,
    ...(managedLifecycle ? { managedLifecycle } : {}),
  };
  await profileReport({ ...config, bakeKey: bake.key }, "lifecycle", report);
} finally {
  try {
    await run("down");
  } catch {
    if (child && !exited) child.kill("SIGTERM");
  }
  if (output) {
    try {
      await deadline(output, 30_000, "final CLI cleanup");
    } catch {
      if (child && !exited) child.kill("SIGKILL");
      await output;
    }
  }
  await infra.cleanup();
}
