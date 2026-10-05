import assert from "node:assert/strict";
import { join } from "node:path";
import { Devnet } from "../src/api.ts";
import { configuration } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import { GENERATION, LABEL } from "../src/docker.ts";
import { Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { StateLock, StateStore } from "../src/storage.ts";

Deno.test("unclean automatic startup serves recovery status without starting clients or inventing a Timeline", async () => {
  const root = await Deno.makeTempDir({ prefix: "panda-recovery-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", root);
  const bake = await readBake("gloas", "p3-checkpoint-r5");
  const config = configuration({ id: "recovery", bake: bake.tag });
  const store = new StateStore(config.id);
  const active = await store.create(config, bake.key);
  active.phase = "running"; // A process died before proving a clean checkpoint.
  await store.write(active);
  const start = Network.prototype.start;
  let starts = 0;
  Network.prototype.start = () => {
    starts++;
    throw new Error("must not start unsafe clients");
  };
  let controller: Controller | undefined;
  try {
    controller = await Controller.start({ id: config.id, bake: bake.tag }, "auto");
    const lifecycle = controller.lifecycle();
    assert.equal(lifecycle.ready, false);
    assert.equal(lifecycle.recoveryRequired, true);
    assert.equal(lifecycle.generation, active.generation);
    assert.equal(lifecycle.now, undefined);
    assert.equal(lifecycle.slot, undefined);
    assert.equal(starts, 0);
    const api = new Devnet(controller.serve(0));
    assert.deepEqual(await api.listSnapshots(), []);
    assert.equal((await api.lifecycle()).recoveryRequired, true);
    await assert.rejects(api.stepSlot(), /faulted|recovery/i);
    await assert.rejects(Controller.start(config, "auto"), /owned by live process/);
    await controller.closePreserving();
    await api.close();
    assert.deepEqual(await store.active(), active);
    const lock = await StateLock.acquire(join(store.root, "network.lock"));
    lock.release();
  } finally {
    await controller?.closePreserving();
    Network.prototype.start = start;
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit recovery discards orphan candidates while holding ownership and preserves other networks", async (t) => {
  for (const action of ["discard", "stop"] as const) {
    await t.step(action, async () => {
      const root = await Deno.makeTempDir({ prefix: "panda-recovery-orphans-" });
      const previous = Deno.env.get("PANDA_DATA_DIR");
      Deno.env.set("PANDA_DATA_DIR", root);
      const bake = await readBake("gloas", "p3-checkpoint-r5");
      const config = configuration({ id: "orphan-owner", bake: bake.tag });
      const network = new Network(config);
      try {
        const source = await network.store.create(config, bake.key);
        const orphan = await network.store.allocate(config, bake.key);
        const clients = new Map<string, Record<string, string>>([
          ["old", { [LABEL]: config.id, [GENERATION]: source.generation }],
          ["candidate", { [LABEL]: config.id, [GENERATION]: orphan.generation }],
          ["unrelated", { [LABEL]: "other-owner", [GENERATION]: orphan.generation }],
        ]);
        const docker = network.infra.docker;
        docker.listContainers = (({ filters }: { filters: { label: string[] } }) => {
          assert(filters.label.includes(`${LABEL}=${config.id}`));
          return Promise.resolve(
            [...clients].filter(([, labels]) =>
              filters.label.every((filter) => {
                const [key, value] = filter.split("=");
                return labels[key] === value;
              })
            ).map(([Id, Labels]) => ({ Id, Labels, State: "exited" })),
          );
        }) as unknown as typeof docker.listContainers;
        docker.listNetworks = (() => Promise.resolve([])) as typeof docker.listNetworks;
        docker.listVolumes = (() =>
          Promise.resolve({ Volumes: [], Warnings: [] })) as typeof docker.listVolumes;
        docker.getContainer = ((id: string) => ({
          remove: async () => {
            await assert.rejects(
              StateLock.acquire(join(network.store.root, "network.lock")),
              /owned by live process/,
            );
            assert.notEqual(id, "unrelated");
            clients.delete(id);
          },
        })) as unknown as typeof docker.getContainer;
        network.saveLogs = () => Promise.resolve();
        await network.enterRecovery();
        await network[action]();
        assert.deepEqual([...clients.keys()], ["unrelated"]);
        await network.store.validate(orphan); // Runtime cleanup does not implicitly delete database evidence.
        if (action === "discard") {
          assert.equal((await network.store.active())!.generation, source.generation);
        } else assert.equal(await network.store.active(), undefined);
        const lock = await StateLock.acquire(join(network.store.root, "network.lock"));
        lock.release();
      } finally {
        network.releaseRecovery();
        if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
        else Deno.env.set("PANDA_DATA_DIR", previous);
        await Deno.remove(root, { recursive: true });
      }
    });
  }
});

Deno.test("recovery rejects explicit configuration overrides before taking ownership", async () => {
  const root = await Deno.makeTempDir({ prefix: "panda-recovery-identity-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", root);
  try {
    const bake = await readBake("gloas", "p3-checkpoint-r5");
    const config = configuration({ id: "recovery-identity", bake: bake.tag, chainId: 1447 });
    const store = new StateStore(config.id);
    const active = await store.create(config, bake.key);
    await assert.rejects(
      Controller.start({ id: config.id, chainId: 1337 }, "auto"),
      /configuration|override/i,
    );
    assert.deepEqual(await store.active(), active);
    const controller = await Controller.start({ id: config.id }, "auto");
    assert.equal(controller.network.config.chainId, 1447);
    await controller.closePreserving();
  } finally {
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("recovery-only service acknowledges explicit shutdown without requiring a running manifest", async () => {
  const root = await Deno.makeTempDir({ prefix: "panda-recovery-shutdown-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", root);
  let controller: Controller | undefined;
  try {
    const bake = await readBake("gloas", "p3-checkpoint-r5");
    const config = configuration({ id: "recovery-shutdown", bake: bake.tag });
    const store = new StateStore(config.id);
    await store.create(config, bake.key);
    controller = await Controller.recover(config.id);
    const docker = controller.network.infra.docker;
    docker.listContainers = (() => Promise.resolve([])) as typeof docker.listContainers;
    docker.listNetworks = (() => Promise.resolve([])) as typeof docker.listNetworks;
    docker.listVolumes = (() =>
      Promise.resolve({ Volumes: [], Warnings: [] })) as typeof docker.listVolumes;
    controller.network.saveLogs = () => Promise.resolve();
    const response = await fetch(`${controller.serve(0)}/control`, {
      method: "POST",
      body: JSON.stringify({ method: "shutdown" }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { id: config.id });
    await controller.close();
    assert.equal(await store.active(), undefined);
  } finally {
    await controller?.close();
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true });
  }
});
