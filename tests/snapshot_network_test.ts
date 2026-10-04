/** Real storage/lifecycle code with Docker and HTTP adapters, not protocol evidence. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { configuration } from "../src/config.ts";
import { EngineGate } from "../src/engine.ts";
import { Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { type ActiveGeneration, fileInventory } from "../src/storage.ts";

async function fixture(
  run: (context: {
    network: Network;
    source: ActiveGeneration;
    candidate: ActiveGeneration;
    clients: Map<string, Parameters<Network["infra"]["container"]>[1]>;
  }) => Promise<void>,
) {
  const base = await Deno.makeTempDir({ prefix: "panda-candidate-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  const fetch = globalThis.fetch;
  const engineStart = EngineGate.start;
  const bake = await readBake("gloas", "p3-checkpoint-r5");
  const network = new Network(configuration({ id: "candidate", bake: bake.tag }));
  const { store, infra, config } = network;
  const clients = new Map<string, Parameters<typeof infra.container>[1]>();
  infra.docker.listContainers = (() => Promise.resolve([])) as typeof infra.docker.listContainers;
  infra.docker.listNetworks = (() => Promise.resolve([])) as typeof infra.docker.listNetworks;
  infra.docker.listVolumes =
    (() => Promise.resolve({ Volumes: [], Warnings: [] })) as typeof infra.docker.listVolumes;
  infra.docker.getImage =
    (() => ({ inspect: () => Promise.resolve({}) })) as unknown as typeof infra.docker.getImage;
  infra.cacheImage = async () => {};
  infra.network = () => Promise.resolve("candidate-fixture");
  infra.cleanup = () => {
    clients.clear();
    return Promise.resolve();
  };
  infra.container = ((role, options) => {
    clients.set(role, options);
    return Promise.resolve({
      start: async () => {},
      inspect: () =>
        Promise.resolve({
          NetworkSettings: {
            Ports: Object.fromEntries(
              Object.keys(options.ExposedPorts ?? {}).map(
                (port) => [port, [{ HostPort: "12345" }]],
              ),
            ),
          },
        }),
    });
  }) as typeof infra.container;
  EngineGate.start = () => Promise.resolve(new EngineGate("http://fixture.invalid", 0));
  globalThis.fetch = (() =>
    Promise.resolve(Response.json({
      result: bake.recipe.engineMethods,
      data: {},
      marks: { parked_ready: 0 },
    }))) as typeof globalThis.fetch;
  try {
    const source = await store.create(config, bake.key);
    const path = store.generationPath(source.generation);
    const shared = join(path, "shared");
    for (const name of ["metadata", "jwt", "validator-keys/keys", "validator-keys/secrets"]) {
      await Deno.mkdir(join(shared, name), { recursive: true });
    }
    await Deno.writeTextFile(join(shared, "jwt/jwtsecret"), "ab".repeat(32));
    await Deno.writeTextFile(
      join(shared, "validator-keys/keys/slashing_protection.sqlite"),
      "SQLite format 3\0fixture",
    );
    await Deno.writeTextFile(join(shared, "validator-keys/keys/key.json"), "{}");
    await Deno.writeTextFile(
      join(shared, "validator-keys/keys/validator_definitions.yml"),
      "keystore_path: /shared/validator-keys/keys/key.json",
    );
    await Deno.writeTextFile(join(path, "admission.json"), "{}");
    source.phase = "stopped";
    source.checkpoint = {
      abi: 1,
      nowMs: config.genesisTime * 1000 + 11_500,
      headSlot: 0,
      forkChoiceSlot: 1,
      headBlockRoot: `0x${"12".repeat(32)}`,
      headStateRoot: `0x${"34".repeat(32)}`,
      checkpointHash: `0x${"56".repeat(32)}`,
      databaseFiles: {
        el: await fileInventory(join(path, "el")),
        bn: await fileInventory(join(path, "bn")),
      },
      sharedFiles: Object.fromEntries(
        await Promise.all(
          ["metadata", "jwt", "validator-keys"].map(
            async (name) => [name, await fileInventory(join(shared, name))],
          ),
        ),
      ),
    };
    await store.write(source);
    const snapshots = new SnapshotStore(store, infra);
    const snapshot = await snapshots.capture(bake);
    const candidate = await snapshots.prepare(snapshot.id, bake, config, async () => {});
    await run({ network, source, candidate, clients });
  } finally {
    await network.fail(new Error("fixture teardown"));
    globalThis.fetch = fetch;
    EngineGate.start = engineStart;
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("candidate starts parked without publishing active state or runtime endpoints", async () => {
  await fixture(async ({ network, source, candidate, clients }) => {
    const oldManifest = { generation: source.generation, sentinel: "source endpoints" };
    await Deno.writeTextFile(
      join(network.store.root, "manifest.json"),
      JSON.stringify(oldManifest),
    );
    const manifest = await network.startCandidate(candidate);
    assert.equal(manifest.generation, candidate.generation);
    assert.deepEqual(await network.store.active(), source);
    assert.deepEqual(await Network.manifest(source.id), oldManifest);
    assert.deepEqual([...clients.keys()], ["el", "bn", "vc"]);
    for (const role of ["bn", "vc"]) {
      assert.ok(clients.get(role)!.Env!.includes("PANDA_CLOCK_PARKED=1"));
    }
    assert.ok(!clients.get("vc")!.Cmd!.includes("--init-slashing-protection"));
    await assert.rejects(network.setPhase("running"), /commit/i);
    await network.commitCandidate();
    assert.equal((await network.store.active())!.generation, candidate.generation);
    assert.equal((await network.store.active())!.phase, "starting");
    assert.equal((await Network.manifest(source.id)).generation, candidate.generation);
    await network.setPhase("running");
    assert.equal((await network.store.active())!.phase, "running");
  });
});

Deno.test("failed or abandoned candidate never faults or destroys the previous generation", async (t) => {
  for (const action of ["startup", "fail", "stop"] as const) {
    await t.step(action, () =>
      fixture(async ({ network, source, candidate }) => {
        if (action === "startup") {
          network.infra.container = () => Promise.reject(new Error("candidate client failed"));
          await assert.rejects(network.startCandidate(candidate), /candidate client failed/);
        } else {
          await network.startCandidate(candidate);
          if (action === "fail") await network.fail(new Error("candidate anchors disagree"));
          else await network.stop();
        }
        assert.deepEqual(await network.store.active(), source);
        await network.store.validate(source);
        await network.store.validate(candidate);
      }));
  }
});

Deno.test("candidate commit rejects a changed source pointer before publication", async () => {
  await fixture(async ({ network, source, candidate }) => {
    await network.startCandidate(candidate);
    const replacement = await network.store.allocate(source.config, source.bakeKey);
    await network.store.write(replacement);
    await assert.rejects(network.commitCandidate(), /changed/);
    assert.deepEqual(await network.store.active(), replacement);
  });
});

Deno.test("candidate commit handles failure before and after pointer publication without implicit rollback", async (t) => {
  for (const published of [false, true]) {
    await t.step(
      published ? "lost publication acknowledgement" : "failed publication",
      () =>
        fixture(async ({ network, source, candidate }) => {
          await network.startCandidate(candidate);
          const rename = Deno.rename;
          Deno.rename = async (from, to) => {
            if (String(to) === join(network.store.root, "active.json")) {
              if (published) await rename(from, to);
              throw new Error("injected pointer publication failure");
            }
            await rename(from, to);
          };
          try {
            await assert.rejects(network.commitCandidate(), /pointer publication failure/);
          } finally {
            Deno.rename = rename;
          }
          await network.fail(new Error("restore commit failed"));
          if (published) {
            assert.equal((await network.store.active())!.generation, candidate.generation);
            assert.equal((await network.store.active())!.phase, "faulted");
          } else assert.deepEqual(await network.store.active(), source);
          await network.store.validate(source);
          await network.store.validate(candidate);
        }),
    );
  }
});
