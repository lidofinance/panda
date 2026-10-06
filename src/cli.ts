import { argumentsFor } from "./arguments.ts";
import { profileName } from "./profiles.ts";
import { Devnet } from "./api.ts";
import { configuration } from "./config.ts";
import { Controller } from "./controller.ts";
import { LABEL, ROLE } from "./docker.ts";
import { defaultTimeoutMs, json, rpc } from "./http.ts";
import { Network } from "./network.ts";
import { stateDirectory, StateStore } from "./storage.ts";
import { runSnapshotCommand } from "./snapshot_cli.ts";

const { flags, positional } = argumentsFor(Deno.args, [
  "profile",
  "bake",
  "snapshot",
  "sha256",
  "operation",
]);
const [command = "up", argument] = positional;
const id = Deno.env.get("PANDA_ID") ?? "local";
const requested = {
  profile: flags.profile ?? Deno.env.get("PANDA_PROFILE"),
  bake: flags.bake ?? Deno.env.get("PANDA_BAKE"),
};
const selection = {
  id,
  ...(requested.profile ? { profile: profileName(requested.profile) } : {}),
  ...(requested.bake ? { bake: requested.bake } : {}),
};
const config = configuration(selection);
const directory = stateDirectory(id);
const endpointFile = `${directory}/controller.json`;
async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function endpoint(): Promise<string | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(endpointFile)).url;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}
async function down(): Promise<void> {
  const url = await endpoint();
  if (url) {
    try {
      const status = await new Devnet(url).lifecycle();
      if (status.id !== id) throw new Error("Controller ownership mismatch");
      await json(`${url}/control`, {
        method: "POST",
        body: JSON.stringify({ method: "shutdown" }),
      });
      // The original controller owns graceful shutdown. Wait until it has released ownership,
      // then finish removal here: its own close errors are visible only in that process.
      const { waitFor } = await import("./http.ts");
      const store = new StateStore(id);
      await waitFor("controller shutdown", async () => await store.ownerReleased() || undefined);
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Deno.errors.ConnectionRefused)) {
        throw error;
      }
    }
  }
  await new Network(config).stop();
}
async function up(): Promise<void> {
  const old = await endpoint();
  if (old) {
    try {
      const status = await new Devnet(old).lifecycle();
      if (status.id !== id) throw new Error("Controller ownership mismatch");
      if (
        (requested.profile && status.profile !== requested.profile) ||
        (requested.bake && status.bake !== requested.bake)
      ) {
        throw new Error(
          `Running ${status.profile}:${status.bake}; requested ${config.profile}:${config.bake}. Use another PANDA_ID or stop this network first.`,
        );
      }
      console.log(JSON.stringify({ event: "already-running", id, url: old }));
      return;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Deno.errors.ConnectionRefused)) {
        throw error;
      }
    }
  }
  await Deno.mkdir(directory, { recursive: true });
  let controller: Controller | undefined;
  const abort = new AbortController();
  const stop = () => abort.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  try {
    // Only explicit choices are compared with retained state or a seed's own configuration.
    controller = await Controller.launch(
      selection,
      flags.snapshot ? { source: flags.snapshot, sha256: flags.sha256 } : undefined,
    );
    const port = Number(Deno.env.get("PANDA_PORT") ?? 8545);
    const url = controller.serve(port);
    await Deno.writeTextFile(endpointFile, JSON.stringify({ url, id, pid: Deno.pid }));
    console.log(
      JSON.stringify({ event: "ready", url, beacon: url, id, lifecycle: controller.lifecycle() }),
    );
    if (!abort.signal.aborted) {
      await Promise.race([
        controller.server!.finished,
        new Promise<void>((resolve) =>
          abort.signal.addEventListener("abort", () => resolve(), { once: true })
        ),
      ]);
    }
  } finally {
    try {
      await controller?.closePreserving();
    } finally {
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
      for (const path of [endpointFile]) {
        await removeIfExists(path);
      }
    }
  }
}
switch (command) {
  case "snapshot": {
    const url = await endpoint();
    if (!url) throw new Error("Run deno task up first");
    const args = positional.slice(1);
    if (flags.operation) args.push("--operation", flags.operation);
    console.log(JSON.stringify(await runSnapshotCommand(url, args)));
    break;
  }
  case "up":
    await up();
    break;
  case "down":
    await down();
    break;
  case "reset":
    await down();
    await up();
    break;
  case "diagnose": {
    const network = new Network(config);
    await network.saveLogs();
    const containers = await network.infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${id}`] },
    });
    console.log(
      JSON.stringify({
        containers: containers.map((c) => ({
          role: c.Labels[ROLE],
          state: c.State,
          status: c.Status,
        })),
      }),
    );
    const m = await Network.manifest(id);
    const probes = {
      el: () => rpc(m.el, "eth_getBlockByNumber", ["latest", false]),
      pool: () => rpc(m.el, "txpool_status"),
      beacon: () => json(`${m.beacon}/eth/v1/beacon/headers/head`),
      sync: () => json(`${m.beacon}/eth/v1/node/syncing`),
      bnClock: () => json(m.bnClock),
      vcClock: () => json(m.vcClock),
    };
    for (const [name, probe] of Object.entries(probes)) {
      try {
        console.log(JSON.stringify({ name, value: await probe() }));
      } catch (error) {
        console.log(JSON.stringify({ name, error: String(error) }));
      }
    }
    break;
  }
  default: {
    const url = await endpoint();
    if (!url) throw new Error("Run deno task up first");
    console.log(
      await json(`${url}/control`, {
        method: "POST",
        body: JSON.stringify({
          method: command,
          params: argument === undefined
            ? []
            : [command === "setAutomine" ? argument === "true" : Number(argument)],
        }),
        signal: AbortSignal.timeout(defaultTimeoutMs()),
      }),
    );
  }
}
