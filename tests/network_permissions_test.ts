import assert from "node:assert/strict";
import type { Devnet } from "../src/api.ts";
import { configuration } from "../src/config.ts";
import { Infrastructure } from "../src/docker.ts";
import { type Manifest, Network } from "../src/network.ts";
import { clockEnvironment, type ProfileName, readBake } from "../src/profiles.ts";
import { depositValidator } from "../bakes/shared/tests/deposit_fixture.ts";

type Options = Parameters<Infrastructure["container"]>[1];
const user = () => `${Deno.uid()}:${Deno.gid()}`;

// Docker/HTTP adapter fixtures only: no daemon, client processes or consensus claims.
async function fixture(
  profile: ProfileName,
  run: (network: Network, manifest: Manifest, created: Map<string, Options>) => Promise<void>,
) {
  const network = new Network(configuration({
    id: `unit-permissions-${crypto.randomUUID().slice(0, 8)}`,
    profile,
    bake: "panda",
    mode: "baseline",
  }));
  const bake = await readBake(profile, "panda");
  const { infra, directory } = network;
  const docker = infra.docker;
  docker.listContainers = (() => Promise.resolve([])) as typeof docker.listContainers;
  docker.listNetworks = (() => Promise.resolve([])) as typeof docker.listNetworks;
  docker.listVolumes =
    (() => Promise.resolve({ Volumes: [], Warnings: [] })) as typeof docker.listVolumes;
  docker.getImage =
    (() => ({ inspect: () => Promise.resolve({}) })) as unknown as typeof docker.getImage;
  infra.cacheImage = async () => {};
  infra.network = () => Promise.resolve("unit-network");
  infra.volume = (role) => Promise.resolve(`unit-${role}`);
  infra.logs = () => Promise.resolve("fixture");
  infra.cleanup = async () => {};
  const created = new Map<string, Options>();
  infra.container = ((role, options) => {
    created.set(role, options);
    return Promise.resolve({
      start: async () => {
        if (role === "genesis") {
          const binding = options.HostConfig?.Binds?.find((value) => value.endsWith(":/data"));
          assert(binding, "genesis must mount its generation shared directory");
          const directory = binding.slice(0, -":/data".length);
          for (const name of ["metadata", "jwt"]) {
            await Deno.mkdir(`${directory}/${name}`, { recursive: true, mode: 0o700 });
          }
          await Deno.writeTextFile(`${directory}/metadata/bootstrap_nodes.txt`, "fixture");
          await Deno.writeTextFile(`${directory}/jwt/jwtsecret`, "ab".repeat(32), { mode: 0o600 });
        }
      },
      wait: () => Promise.resolve({ StatusCode: 0 }),
      remove: async () => {},
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(Response.json({
      result: bake.recipe.engineMethods,
      data: {},
    }))) as typeof fetch;
  try {
    const manifest = await network.start();
    await run(network, manifest, created);
  } finally {
    globalThis.fetch = originalFetch;
    docker.listContainers = (() => Promise.resolve([])) as typeof docker.listContainers;
    await network.stop();
    await Deno.remove(directory, { recursive: true });
  }
}

for (const profile of ["pectra", "gloas"] as const) {
  Deno.test(`${profile}: clients write bind-mounted files as the controller user`, async () => {
    await fixture(profile, async (_network, manifest, created) => {
      for (const role of ["genesis", "init", "el", "bn", "vc"]) {
        assert.equal(created.get(role)?.User, user(), `${role} must use the controller UID:GID`);
      }
      assert.equal(
        await Deno.readTextFile(`${manifest.directory}/metadata/bootstrap_nodes.txt`),
        "",
      );
    });
  });
}

for (const originalUser of ["1001:1234", "0:0"]) {
  Deno.test(`fast VC restart preserves its original user ${originalUser}`, async () => {
    await fixture("pectra", async (network, manifest, created) => {
      const vc = created.get("vc")!;
      const { startMs, port } = clockEnvironment(manifest.bake.recipe);
      const nowMs = manifest.config.genesisTime * 1000 + 8192 * 12000;
      const env = [`${port}=5059`, `${startMs}=11500`];
      const docker = network.infra.docker;
      docker.listContainers = (() =>
        Promise.resolve([{ Id: "old-vc" }])) as typeof docker.listContainers;
      docker.getContainer = (() => ({
        inspect: () =>
          Promise.resolve({
            Image: vc.Image,
            Config: { ...vc, User: originalUser, Env: env },
            HostConfig: vc.HostConfig,
          }),
        stop: async () => {},
        remove: async () => {},
      })) as unknown as typeof docker.getContainer;
      globalThis.fetch = (() =>
        Promise.resolve(Response.json({
          nowMs,
          marks: { ready: 0, indices: 0, skip_ready: 8192 },
        }))) as typeof fetch;
      await network.skipValidator(manifest, nowMs);
      const replacement = created.get("vc")!;
      assert.equal(replacement.User, originalUser);
      assert.deepEqual(replacement.HostConfig?.Binds, vc.HostConfig?.Binds);
      assert.deepEqual(replacement.Cmd, vc.Cmd);
      assert.deepEqual(replacement.Env, [`${port}=5059`, `${startMs}=${nowMs}`]);
    });
  });
}

Deno.test("deposit key generation uses the controller user for private host-readable keys", async () => {
  await fixture("pectra", async (_network, manifest) => {
    const original = Infrastructure.prototype.container;
    const stop = new Error("Stop before running the fixture container");
    let options: Options | undefined;
    Infrastructure.prototype.container = (role, value) => {
      assert.equal(role, "deposit-fixture");
      options = value;
      return Promise.reject(stop);
    };
    try {
      const net = {
        status: () => Promise.resolve({ id: manifest.config.id }),
      } as unknown as Devnet;
      await assert.rejects(depositValidator(net, 64), (error) => error === stop);
      assert.equal(options?.User, user());
      assert.deepEqual(options?.HostConfig?.Binds, [`${manifest.directory}:/data`]);
    } finally {
      Infrastructure.prototype.container = original;
    }
  });
});

for (const completes of [true, false]) {
  Deno.test(
    `prepared skip ${
      completes
        ? "allows slow CL state preparation"
        : "times out without restarting the VC on a wrong slot"
    }`,
    async () => {
      await fixture("gloas", async (network, manifest, created) => {
        const original = created.get("vc")!;
        const slot = 22593;
        const nowMs = manifest.config.genesisTime * 1000 + slot * 12000 + 11500;
        manifest.bake.recipe.preparedSkip = true;
        let stopped = 0;
        let removed = 0;
        let probes = 0;
        const docker = network.infra.docker;
        docker.listContainers = (() =>
          Promise.resolve([{ Id: "old-vc" }])) as typeof docker.listContainers;
        docker.getContainer = (() => ({
          inspect: () =>
            Promise.resolve({
              Image: original.Image,
              Config: original,
              HostConfig: original.HostConfig,
            }),
          stop: () => {
            stopped++;
            return Promise.resolve();
          },
          remove: () => {
            removed++;
            return Promise.resolve();
          },
        })) as unknown as typeof docker.getContainer;
        const now = performance.now;
        let elapsed = 0;
        // Advance only the wall-clock fixture; no protocol time or real client is simulated here.
        performance.now = () => elapsed;
        globalThis.fetch = ((url) => {
          if (String(url) === manifest.bnClock && removed === 0) {
            probes++;
            elapsed += completes ? 180_000 : 900_001;
            return Promise.resolve(Response.json({
              marks: { skip_ready: completes && probes >= 2 ? slot : slot - 1 },
            }));
          }
          return Promise.resolve(Response.json({ nowMs, marks: { ready: 0, indices: 0 } }));
        }) as typeof fetch;
        try {
          if (completes) {
            await network.skipValidator(manifest, nowMs);
            assert.equal(probes, 2);
            assert.equal(removed, 1);
            assert.notEqual(created.get("vc"), original);
          } else {
            await assert.rejects(
              network.skipValidator(manifest, nowMs),
              /Timed out: prepared empty-slot state.*22593.*3600000/,
            );
            assert.equal(probes, 4);
            assert.equal(removed, 0);
            assert.equal(created.get("vc"), original);
          }
          assert.equal(stopped, 1);
        } finally {
          performance.now = now;
        }
      });
    },
  );
}
