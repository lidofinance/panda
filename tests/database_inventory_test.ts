/** Filesystem and Docker adapter checks only; no real client checkpoint is claimed here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { configuration } from "../src/config.ts";
import { Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { fileInventory, StateLock } from "../src/storage.ts";

async function fixture(run: (network: Network, path: string) => Promise<void>) {
  const base = await Deno.makeTempDir({ prefix: "panda-db-inventory-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  const config = configuration({ id: "db-inventory", profile: "gloas", bake: "inventory-fixture" });
  const network = new Network(config);
  const bake = await readBake("gloas", "panda");
  bake.tag = config.bake;
  bake.recipe.checkpointAbi = 1;
  const value = await network.store.create(config, bake.key);
  network.generation = value;
  Object.defineProperty(network, "lock", {
    value: await StateLock.acquire(`${network.store.root}/network.lock`),
    writable: true,
  });
  const path = network.store.generationPath(value.generation);
  const keys = `${path}/shared/validator-keys/keys`;
  await Deno.mkdir(keys, { recursive: true });
  for (const name of ["metadata", "jwt"]) {
    await Deno.mkdir(`${path}/shared/${name}`, { recursive: true });
    await Deno.writeTextFile(`${path}/shared/${name}/fixture`, name);
  }
  await Deno.writeTextFile(`${keys}/slashing_protection.sqlite`, "SQLite format 3\0test fixture");
  await Deno.writeTextFile(
    `${keys}/validator_definitions.yml`,
    "keystore_path: /shared/validator-keys/keys/key.json\n",
  );
  await Deno.writeTextFile(`${keys}/key.json`, "key fixture");
  await Deno.writeTextFile(`${path}/el/state.db`, "execution state");
  await Deno.writeTextFile(`${path}/bn/state.db`, "consensus state");
  network.infra.stopClients = async () => {
    // A client's final shutdown flush must be part of the saved inventory.
    await Deno.writeTextFile(`${path}/el/state.db`, "execution state after clean shutdown");
  };
  network.saveLogs = () => Promise.resolve();
  network.infra.cleanup = () => Promise.resolve();
  const originalRead = Deno.readTextFile;
  Deno.readTextFile =
    ((file, options) =>
      String(file) === "bakes/gloas/tags/inventory-fixture.json"
        ? Promise.resolve(JSON.stringify(bake))
        : originalRead(file, options)) as typeof Deno.readTextFile;
  try {
    await network.preserve({
      abi: 1,
      nowMs: config.genesisTime * 1000 + 11_500,
      headSlot: 0,
      headBlockRoot: `0x${"11".repeat(32)}`,
      headStateRoot: `0x${"22".repeat(32)}`,
      forkChoiceSlot: 1,
      checkpointHash: `0x${"33".repeat(32)}`,
    });
    await run(network, path);
  } finally {
    Deno.readTextFile = originalRead;
    await network.stop();
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("preservation records the final stopped EL and BN files", async () => {
  await fixture(async (network, path) => {
    assert.deepEqual(network.generation?.checkpoint?.databaseFiles, {
      el: await fileInventory(`${path}/el`),
      bn: await fileInventory(`${path}/bn`),
    });
  });
});

Deno.test("missing or changed EL/BN data is refused before creating any Docker runtime", async (t) => {
  for (const role of ["el", "bn"]) {
    for (const mutation of ["missing", "changed"]) {
      await t.step(`${role}: ${mutation}`, async () => {
        await fixture(async (network, path) => {
          const database = `${path}/${role}/state.db`;
          if (mutation === "missing") await Deno.remove(database);
          else await Deno.writeTextFile(database, "corrupt database");
          const reopened = new Network(network.config);
          const docker = reopened.infra.docker;
          docker.listContainers = (() => Promise.resolve([])) as typeof docker.listContainers;
          docker.listNetworks = (() => Promise.resolve([])) as typeof docker.listNetworks;
          docker.listVolumes = (() =>
            Promise.resolve({ Volumes: [], Warnings: [] })) as typeof docker.listVolumes;
          docker.getImage = (() => ({
            inspect: () => Promise.resolve({}),
          })) as unknown as typeof docker.getImage;
          reopened.infra.cacheImage = () => Promise.resolve();
          reopened.saveLogs = () => Promise.resolve();
          reopened.infra.cleanup = () => Promise.resolve();
          let runtimeCreations = 0;
          reopened.infra.network = () => {
            runtimeCreations++;
            return Promise.reject(new Error("Unexpected Docker runtime creation"));
          };
          await assert.rejects(
            reopened.start("resume"),
            /Preserved execution or consensus database files changed/,
          );
          assert.equal(runtimeCreations, 0);
          assert.equal((await reopened.store.active())?.phase, "faulted");
        });
      });
    }
  }
});

Deno.test("database inventory hashes large files incrementally with exact bytes and size", async () => {
  const base = await Deno.makeTempDir({ prefix: "panda-streamed-inventory-" });
  const path = `${base}/large.ldb`;
  const chunk = new Uint8Array(512 * 1024).fill(19);
  const expected = createHash("sha256");
  using file = await Deno.open(path, { createNew: true, write: true });
  for (let i = 0; i < 64; i++) {
    await file.write(chunk);
    expected.update(chunk);
  }
  const original = Deno.readFile;
  Deno.readFile = ((name, options) => {
    if (String(name) === path) {
      throw new Error("Whole database-file allocation exceeds the inventory memory budget");
    }
    return original(name, options);
  }) as typeof Deno.readFile;
  try {
    assert.deepEqual(await fileInventory(base), {
      "large.ldb": { hash: expected.digest("hex"), size: chunk.length * 64 },
    });
  } finally {
    Deno.readFile = original;
    await Deno.remove(base, { recursive: true });
  }
});
