import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { configuration } from "../../../src/config.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { waitFor } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { profileReport } from "./report.ts";
import { readBake } from "../../../src/profiles.ts";
import { stateDirectory, StateStore } from "../../../src/storage.ts";

const id = `lifecycle-${crypto.randomUUID().slice(0, 8)}`;
const env = { PANDA_ID: id, PANDA_PORT: "0" };
const infra = new Infrastructure(id);
const config = configuration();
const bake = await readBake(config.profile, config.bake);
const snapshots = config.profile === "gloas" && bake.recipe.ptcReadiness === true;
const command = (task: string) =>
  new Deno.Command(Deno.execPath(), {
    // Spawn the controller itself so the crash check cannot leave a task-launcher child alive.
    args: ["run", "-A", "src/cli.ts", task],
    env,
    stdout: "piped",
    stderr: "piped",
  });
let child: Deno.ChildProcess | undefined;
let output: Promise<Deno.CommandOutput> | undefined;
const start = async (task: string, ready = true) => {
  child = command(task).spawn();
  output = child.output();
  return await waitFor("CLI ready", async () => {
    const endpoint = JSON.parse(await Deno.readTextFile(`${stateDirectory(id)}/controller.json`));
    const net = new Devnet(endpoint.url);
    const lifecycle = await net.lifecycle();
    return lifecycle.id === id && lifecycle.ready === ready ? net : undefined;
  }, 120_000);
};
const run = async (task: string) => {
  const result = await command(task).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
};
const empty = async () => {
  const filters = { label: [`${LABEL}=${id}`] };
  assert.equal((await infra.docker.listContainers({ all: true, filters })).length, 0);
  assert.equal((await infra.docker.listNetworks({ filters })).length, 0);
  assert.equal((await infra.docker.listVolumes({ filters })).Volumes?.length ?? 0, 0);
  assert.equal(await new StateStore(id).active(), undefined, "down retained an active generation");
};
const started = performance.now();
try {
  const first = await start("up");
  const genesis = (await first.status()).el.hash;
  assert((await run("up")).includes("already-running"));
  const running = await first.status();
  const incompatible = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config=deno.json",
      "-A",
      "src/cli.ts",
      "up",
      "--profile",
      running.profile === "pectra" ? "gloas" : "pectra",
    ],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(!incompatible.success);
  assert(new TextDecoder().decode(incompatible.stderr).includes("requested"));
  await assert.rejects(new Network(configuration({ id })).start(), /owned by live process/);
  await first.stepSlot();
  if (snapshots) {
    await first.stop();
    const parked = await first.lifecycle();
    assert.equal(parked.phase, "parked");
    assert.equal(parked.ready, false);
    assert((await run("up")).includes("already-running"), "up rejected a parked controller");
    assert.equal(
      (await first.lifecycle()).sessionId,
      parked.sessionId,
      "up replaced the parked network",
    );
  }
  await run("down");
  assert((await output!).success);
  await empty();
  await run("down");
  const second = await start("reset");
  assert.equal((await second.status()).el.hash, genesis, "genesis changed on reset");
  assert.equal((await second.status()).slot, 0);
  await second.stepSlot();
  if (snapshots) {
    // Abrupt controller loss leaves a durable unclean generation and its real clients.
    // The next up exposes recovery; an ordinary up/down/reset must still be usable there.
    child!.kill("SIGKILL");
    assert.equal((await output!).success, false);
    const recovery = await start("up", false);
    assert.equal((await recovery.lifecycle()).recoveryRequired, true);
    assert((await run("up")).includes("already-running"), "up rejected a recovery controller");
    const recoveryExit = output!;
    const fresh = await start("reset");
    assert((await recoveryExit).success, "reset could not shut down the recovery controller");
    assert.equal((await fresh.status()).el.hash, genesis);
    assert.equal((await fresh.status()).slot, 0);
    await fresh.stepSlot();
  }
  await run("down");
  assert((await output!).success);
  await empty();
  const report = {
    event: "lifecycle-passed",
    elapsedMs: performance.now() - started,
    repeatedUp: true,
    repeatedDown: true,
    resetGenesis: genesis,
    duplicateOwnerRejected: true,
    differentProfileRejected: true,
    parkedControllerUpAndDown: snapshots,
    recoveryControllerUpAndReset: snapshots,
  };
  await profileReport({ ...config, bakeKey: bake.key }, "lifecycle", report);
} finally {
  try {
    await run("down");
  } catch {
    child?.kill("SIGTERM");
  }
  await output;
  await new Network(configuration({ id })).stop();
}
