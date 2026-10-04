import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { GENERATION, LABEL, ROLE } from "../src/docker.ts";
import { Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";

// Actual filesystem/lifecycle paths with Docker and client HTTP adapters; no daemon is used.
async function fixture(run: (network: Network) => Promise<void>, failedGenesis = false) {
  const base = await Deno.makeTempDir({ prefix: "panda-logs-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  const originalFetch = globalThis.fetch;
  Deno.env.set("PANDA_DATA_DIR", base);
  const network = new Network(configuration({ id: "logs", bake: "panda", mode: "baseline" }));
  const bake = await readBake("gloas", "panda");
  const { infra } = network;
  const docker = infra.docker;
  const clients = new Map<string, { Id: string; Labels: Record<string, string> }>();
  docker.listContainers = ((options) => {
    assert(options && typeof options === "object");
    assert.deepEqual(options.filters, { label: [`${LABEL}=logs`] });
    return Promise.resolve([...clients.values()]);
  }) as typeof docker.listContainers;
  docker.listNetworks = (() => Promise.resolve([])) as typeof docker.listNetworks;
  docker.listVolumes =
    (() => Promise.resolve({ Volumes: [], Warnings: [] })) as typeof docker.listVolumes;
  docker.getImage =
    (() => ({ inspect: () => Promise.resolve({}) })) as unknown as typeof docker.getImage;
  docker.getContainer = ((id) => ({ id })) as typeof docker.getContainer;
  infra.cacheImage = async () => {};
  infra.network = () => Promise.resolve("fixture-network");
  infra.cleanup = () => {
    clients.clear();
    return Promise.resolve();
  };
  infra.logs = (client) => Promise.resolve(`diagnostic ${client.id}\n`);
  infra.container = ((role, options) => {
    clients.set(role, { Id: role, Labels: { ...infra.labels, [ROLE]: role } });
    return Promise.resolve({
      id: role,
      start: async () => {
        if (role === "genesis") {
          await Deno.mkdir(`${network.directory}/metadata`);
          await Deno.mkdir(`${network.directory}/jwt`);
          await Deno.writeTextFile(`${network.directory}/jwt/jwtsecret`, "ab".repeat(32));
        }
      },
      wait: () => Promise.resolve({ StatusCode: failedGenesis ? 1 : 0 }),
      remove: () => {
        clients.delete(role);
        return Promise.resolve();
      },
      inspect: () =>
        Promise.resolve({
          NetworkSettings: {
            Ports: Object.fromEntries(
              Object.keys(options.ExposedPorts ?? {}).map((
                port,
              ) => [port, [{ HostPort: "12345" }]]),
            ),
          },
        }),
    });
  }) as typeof infra.container;
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ result: bake.recipe.engineMethods, data: {} }),
    )) as typeof fetch;
  try {
    await run(network);
  } finally {
    await network.stop();
    globalThis.fetch = originalFetch;
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("owning stop removes its generation but retains genesis, init and client logs", async () => {
  await fixture(async (network) => {
    const manifest = await network.start();
    const generation = network.store.generationPath(manifest.generation!);
    const logs = `${network.store.root}/logs/${manifest.generation}`;
    await Deno.writeTextFile(
      `${manifest.directory}/private-runtime-data`,
      "not diagnostic evidence",
    );
    await network.stop();
    assert.equal(await network.store.active(), undefined);
    await assert.rejects(Deno.stat(generation), Deno.errors.NotFound);
    for (const role of ["genesis", "init", "el", "bn", "vc"]) {
      assert.equal(await Deno.readTextFile(`${logs}/${role}.log`), `diagnostic ${role}\n`);
    }
    assert.deepEqual([...Deno.readDirSync(logs)].map((entry) => entry.name).sort(), [
      "bn.log",
      "el.log",
      "genesis.log",
      "init.log",
      "vc.log",
    ]);
    await network.stop();
    assert.equal(await Deno.readTextFile(`${logs}/el.log`), "diagnostic el\n");
  });
});

Deno.test("failed fresh genesis retains its diagnostics after generation cleanup", async () => {
  await fixture(async (network) => {
    await assert.rejects(network.start(), /genesis failed: diagnostic genesis/);
    assert.equal(await network.store.active(), undefined);
    assert.deepEqual([...Deno.readDirSync(`${network.store.root}/generations`)], []);
    const saved = [...Deno.readDirSync(`${network.store.root}/logs`)];
    assert.equal(saved.length, 1);
    assert.equal(
      await Deno.readTextFile(`${network.store.root}/logs/${saved[0].name}/genesis.log`),
      "diagnostic genesis\n",
    );
  }, true);
});

Deno.test("diagnose uses the container generation label without loading active runtime", async () => {
  await fixture(async (network) => {
    await network.store.initialize();
    const generation = crypto.randomUUID();
    network.infra.docker.listContainers = (() =>
      Promise.resolve([
        { Id: "el", Labels: { [LABEL]: "logs", [ROLE]: "el", [GENERATION]: generation } },
        { Id: "legacy", Labels: { [LABEL]: "logs", [ROLE]: "bn" } },
      ])) as unknown as typeof network.infra.docker.listContainers;
    await network.saveLogs();
    assert.equal(network.generation, undefined);
    assert.equal(
      await Deno.readTextFile(`${network.store.root}/logs/${generation}/el.log`),
      "diagnostic el\n",
    );
    assert.equal(
      await Deno.readTextFile(`${network.store.root}/logs/runtime/bn.log`),
      "diagnostic legacy\n",
    );
  });
});

Deno.test("diagnostic writes reject foreign labels, escaping names and symlink destinations", async (t) => {
  for (
    const unsafe of ["foreign", "role", "generation", "logs-link", "generation-link", "file-link"]
  ) {
    await t.step(unsafe, () =>
      fixture(async (network) => {
        await network.store.initialize();
        const generation = crypto.randomUUID();
        const labels: Record<string, string> = {
          [LABEL]: "logs",
          [ROLE]: "el",
          [GENERATION]: generation,
        };
        const logs = `${network.store.root}/logs`;
        const outside = `${network.store.root}/sentinel`;
        await Deno.mkdir(outside);
        await Deno.writeTextFile(`${outside}/el.log`, "preserve this evidence");
        if (unsafe === "foreign") labels[LABEL] = "other-owner";
        if (unsafe === "role") labels[ROLE] = "../../sentinel/el";
        if (unsafe === "generation") labels[GENERATION] = "../sentinel";
        if (unsafe === "logs-link") await Deno.symlink(outside, logs);
        if (unsafe === "generation-link" || unsafe === "file-link") {
          await Deno.mkdir(logs);
          if (unsafe === "generation-link") await Deno.symlink(outside, `${logs}/${generation}`);
          else {
            await Deno.mkdir(`${logs}/${generation}`);
            await Deno.symlink(`${outside}/el.log`, `${logs}/${generation}/el.log`);
          }
        }
        const docker = network.infra.docker;
        const list = docker.listContainers;
        docker.listContainers = (() =>
          Promise.resolve([{ Id: "el", Labels: labels }])) as typeof docker.listContainers;
        try {
          await assert.rejects(network.saveLogs(), /ownership|Invalid|Unsafe/);
          assert.equal(await Deno.readTextFile(`${outside}/el.log`), "preserve this evidence");
        } finally {
          docker.listContainers = list;
        }
      }));
  }
});
