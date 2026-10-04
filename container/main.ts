import type { Controller } from "../src/controller.ts";
import { startServiceController, stopServiceController, waitForServiceDocker } from "./service.ts";
import { Infrastructure } from "../src/docker.ts";
import { profileName, readBake } from "../src/profiles.ts";
import { releaseMetadata } from "../src/release.ts";
import { type Relay, tcpRelay } from "./relay.ts";

const release = JSON.parse(await Deno.readTextFile("release.json"));
const bake = await readBake(profileName(release.profile), release.bake);
if (
  JSON.stringify(releaseMetadata(bake, release.image, release.sourceCommit, release.lighthouse)) !==
    JSON.stringify(release)
) {
  throw new Error("Packaged release metadata does not match the bake");
}
if (!Deno.env.has("PANDA_DATA_DIR")) Deno.env.set("PANDA_DATA_DIR", "/data/panda");
const id = "service";
const infra = new Infrastructure(id);
const abort = new AbortController();
const stop = () => abort.abort();
Deno.addSignalListener("SIGINT", stop);
Deno.addSignalListener("SIGTERM", stop);
// Explicit dockerd arguments bypass the upstream entrypoint's default TCP listener.
const daemon = new Deno.Command("dockerd-entrypoint.sh", {
  args: [
    "dockerd",
    "--host=unix:///var/run/docker.sock",
    "--config-file=/opt/panda/container/daemon.json",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
let daemonExited = false;
const daemonStopped = new AbortController();
const daemonExit = daemon.status.then((status) => {
  daemonExited = true;
  daemonStopped.abort(new Error(`Private Docker exited: ${status.code}`));
  return status;
});
const startupSignal = AbortSignal.any([abort.signal, daemonStopped.signal]);
let controller: Controller | undefined;
const relays: Relay[] = [];
try {
  await waitForServiceDocker(() => infra.docker.ping(), abort.signal, daemonExit);
  for (const role of ["el", "cl", "genesis"] as const) {
    startupSignal.throwIfAborted();
    if (!await infra.restoreImage(bake.images[role].id)) throw new Error(`Missing ${role} archive`);
    startupSignal.throwIfAborted();
  }
  await Deno.mkdir("/run/panda", { recursive: true });
  await Deno.writeTextFile("/run/panda/id", id, { mode: 0o600 });
  startupSignal.throwIfAborted();
  controller = await startServiceController(bake, startupSignal);
  startupSignal.throwIfAborted();
  const upstream = controller.serve(0);
  const beacon = controller.serveClient("beacon");
  const validator = controller.serveClient("vc");
  relays.push(tcpRelay(() => upstream, 8545));
  relays.push(tcpRelay(() => beacon, 5052));
  relays.push(tcpRelay(() => validator, 5062));
  console.log(JSON.stringify({
    event: "ready",
    id,
    url: "http://127.0.0.1:8545",
    beacon: "http://127.0.0.1:5052",
    validator: "http://127.0.0.1:5062",
    persistence: controller.lifecycle().checkpointCapable ? "checkpoint" : "ephemeral-legacy-bake",
    ...release,
  }));
  if (!abort.signal.aborted) {
    await Promise.race([
      new Promise<void>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(), { once: true })
      ),
      daemonExit.then((status) => {
        throw new Error(`Private Docker exited: ${status.code}`);
      }),
      controller.server!.finished,
      ...relays.map((relay) => relay.finished),
    ]);
  }
} finally {
  stop();
  await Promise.allSettled(relays.map((relay) => relay.close()));
  try {
    if (controller) await stopServiceController(controller);
  } finally {
    if (!daemonExited) daemon.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (!daemonExited) daemon.kill("SIGKILL");
    }, 30_000);
    await daemonExit;
    clearTimeout(timeout);
    Deno.removeSignalListener("SIGINT", stop);
    Deno.removeSignalListener("SIGTERM", stop);
  }
}
