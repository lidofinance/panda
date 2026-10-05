import { argumentsFor } from "./arguments.ts";
import { profileName } from "./profiles.ts";
import { Devnet } from "./api.ts";
import { configuration } from "./config.ts";
import { Controller } from "./controller.ts";
import { Infrastructure, LABEL, ROLE } from "./docker.ts";
import { defaultTimeoutMs, json, rpc } from "./http.ts";
import { Network } from "./network.ts";
import { stateDirectory, StateLock, StateStore } from "./storage.ts";
import { SnapshotStore } from "./snapshots.ts";
import { SnapshotJournal } from "./snapshot_operations.ts";
import { isSnapshotId, saveSnapshotStream } from "./snapshot_archive.ts";

const { flags, positional } = argumentsFor(Deno.args, ["profile", "bake", "operation", "sha256"]);
const [command = "up", argument] = positional;
const id = Deno.env.get("PANDA_ID") ?? "local";
const config = configuration({
  id,
  ...(flags.profile ? { profile: profileName(flags.profile) } : {}),
  ...(flags.bake ? { bake: flags.bake } : {}),
});
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
async function liveController(): Promise<Devnet | undefined> {
  const url = await endpoint();
  if (!url) return;
  const net = new Devnet(url);
  let status: Awaited<ReturnType<Devnet["lifecycle"]>>;
  try {
    status = await net.lifecycle();
  } catch (error) {
    await net.close();
    if (error instanceof TypeError || error instanceof Deno.errors.ConnectionRefused) return;
    throw error;
  }
  if (status?.id !== id) {
    await net.close();
    throw new Error("Controller ownership mismatch");
  }
  return net;
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
      // The original controller owns graceful shutdown. Wait for all its resources to disappear.
      const { waitFor } = await import("./http.ts");
      const infra = new Infrastructure(id);
      await waitFor(
        "controller shutdown",
        async () => {
          const filters = { label: [`${LABEL}=${id}`] };
          const [containers, networks, volumes] = await Promise.all([
            infra.docker.listContainers({ all: true, filters }),
            infra.docker.listNetworks({ filters }),
            infra.docker.listVolumes({ filters }),
          ]);
          let endpointPresent = true;
          try {
            await Deno.stat(endpointFile);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) endpointPresent = false;
            else throw error;
          }
          return !containers.length && !networks.length && !volumes.Volumes?.length &&
              !endpointPresent
            ? true
            : undefined;
        },
      );
      return;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Deno.errors.ConnectionRefused)) {
        throw error;
      }
    }
  }
  await new Network(config).stop();
}
async function up(
  mode: "new" | "resume" | "recover" | { snapshot: string } = "new",
): Promise<void> {
  if (typeof mode === "object" && (flags.profile || (isSnapshotId(mode.snapshot) && flags.bake))) {
    throw new Error(
      "Snapshot startup uses its recorded configuration; omit profile/bake overrides",
    );
  }
  const old = await endpoint();
  if (old) {
    try {
      const status = await new Devnet(old).lifecycle();
      if (status.id !== id) throw new Error("Controller ownership mismatch");
      if (typeof mode === "object") {
        throw new Error("Controller is already running; use snapshot restore <id>");
      }
      if (
        mode !== "recover" && (status.profile !== config.profile || status.bake !== config.bake)
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
  const lock = await StateLock.acquire(`${directory}/controller.lock`);
  let controller: Controller | undefined;
  const abort = new AbortController();
  const stop = () => abort.abort();
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  try {
    controller = typeof mode === "object"
      ? await Controller.fromSnapshot(mode.snapshot, id, flags.operation, {
        bake: flags.bake,
        sha256: flags.sha256,
        signal: abort.signal,
      })
      : mode === "recover"
      ? await Controller.recover(id, abort.signal)
      : await Controller.start(config, mode, abort.signal);
    const port = Number(Deno.env.get("PANDA_PORT") ?? 8545);
    const url = controller.serve(port);
    await Deno.writeTextFile(endpointFile, JSON.stringify({ url, id, pid: Deno.pid }));
    console.log(
      JSON.stringify({
        event: controller.lifecycle().ready ? "ready" : "recovery-required",
        url,
        beacon: url,
        id,
        time: controller.lifecycle().now,
      }),
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
      if (mode === "recover" || typeof mode === "object") await controller?.closePreserving();
      else await controller?.close();
    } finally {
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
      try {
        await removeIfExists(endpointFile);
      } finally {
        lock.release();
      }
    }
  }
}
switch (command) {
  case "up":
    await up();
    break;
  case "open":
    await up("resume");
    break;
  case "recover":
    await up("recover");
    break;
  case "down":
    await down();
    break;
  case "reset":
    await down();
    await up();
    break;
  case "snapshot": {
    const action = argument ?? "list";
    const reference = positional[2];
    if (action === "open" && reference) {
      await up({ snapshot: reference });
      break;
    }
    await using net = await liveController();
    let result: unknown;
    if (net) {
      if (action === "create") result = await net.createSnapshot({ operationId: flags.operation });
      else if (action === "export" && reference && positional[3]) {
        result = await net.exportSnapshot(reference, positional[3]);
      } else if (action === "restore" && reference) {
        result = await net.restoreSnapshot(reference, { operationId: flags.operation });
      } else if (action === "remove" && reference) {
        result = await net.removeSnapshot(reference, { operationId: flags.operation });
      } else if (action === "list") result = await net.listSnapshots();
      else if (action === "operation" && reference) result = await net.snapshotOperation(reference);
      else {throw new Error(
          "Use snapshot create, restore <id>, remove <id>, list or operation <id>",
        );}
    } else {
      const store = new StateStore(id);
      if (action === "list") result = await new SnapshotStore(store, new Infrastructure(id)).list();
      else if (action === "export" && reference && positional[3]) {
        const exported = await new SnapshotStore(store, new Infrastructure(id)).export(reference);
        try {
          const file = await Deno.open(exported.path, { read: true });
          result = await saveSnapshotStream(file.readable, positional[3], {
            sha256: exported.sha256,
          });
        } finally {
          await exported.cleanup();
        }
      } else if (action === "operation" && reference) {
        result = await new SnapshotJournal(store).read(reference);
      } else if (action === "remove" && reference) {
        result = await new SnapshotJournal(store).remove(
          new SnapshotStore(store, new Infrastructure(id)),
          reference,
          flags.operation ?? crypto.randomUUID(),
        );
      } else {throw new Error(
          "Start the controller first, or use snapshot open <id> for an offline artifact",
        );}
    }
    console.log(JSON.stringify(result));
    break;
  }
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
