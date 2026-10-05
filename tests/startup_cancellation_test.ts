import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { ROLE } from "../src/docker.ts";
import { Network } from "../src/network.ts";
import { bakePath, readBake } from "../src/profiles.ts";
import { deadline, delay, json, rpc, waitFor } from "../src/http.ts";

type Hooks = {
  create?: (role: string) => Promise<void>;
  wait?: (role: string, signal?: AbortSignal) => Promise<{ StatusCode: number }>;
  request?: (method: string, signal?: AbortSignal) => Promise<Response>;
};
async function fixture(run: (network: Network, events: string[], hooks: Hooks) => Promise<void>) {
  const base = await Deno.makeTempDir();
  const previous = Deno.env.get("PANDA_DATA_DIR"), originalFetch = globalThis.fetch;
  const tag = `startup-${crypto.randomUUID().slice(0, 8)}`;
  const bake = await readBake("gloas", "panda");
  bake.tag = tag;
  bake.recipe.checkpointAbi = 1;
  await Deno.writeTextFile(bakePath("gloas", tag), JSON.stringify(bake));
  Deno.env.set("PANDA_DATA_DIR", base);
  const network = new Network(configuration({ id: "startup", bake: tag, mode: "baseline" }));
  const { infra } = network, docker = infra.docker;
  const events: string[] = [], hooks: Hooks = {};
  const clients = new Map<string, { Id: string; Labels: Record<string, string> }>();
  docker.listContainers =
    (() => Promise.resolve([...clients.values()])) as typeof docker.listContainers;
  docker.listNetworks = (() => Promise.resolve([])) as typeof docker.listNetworks;
  docker.listVolumes =
    (() => Promise.resolve({ Volumes: [], Warnings: [] })) as typeof docker.listVolumes;
  docker.getImage =
    (() => ({ inspect: () => Promise.resolve({}) })) as unknown as typeof docker.getImage;
  docker.getContainer = ((id) => ({ id })) as typeof docker.getContainer;
  infra.cacheImage = async () => {};
  infra.network = () => {
    events.push("network");
    return Promise.resolve("fixture-network");
  };
  infra.cleanup = () => {
    events.push("cleanup");
    clients.clear();
    return Promise.resolve();
  };
  infra.logs = (client) => Promise.resolve(`diagnostic ${client.id}\n`);
  infra.container = (async (role, options) => {
    await hooks.create?.(role);
    events.push(`${role}:create`);
    clients.set(role, { Id: role, Labels: { ...infra.labels, [ROLE]: role } });
    return {
      id: role,
      start: async () => {
        events.push(`${role}:start`);
        if (role === "genesis") {
          for (const name of ["metadata", "jwt"]) await Deno.mkdir(`${network.directory}/${name}`);
          await Deno.writeTextFile(`${network.directory}/jwt/jwtsecret`, "ab".repeat(32));
        }
      },
      wait: (options?: { abortSignal?: AbortSignal }) =>
        hooks.wait?.(role, options?.abortSignal) ?? Promise.resolve({ StatusCode: 0 }),
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
    };
  }) as typeof infra.container;
  globalThis.fetch = (async (_input, init) => {
    const method = init?.body ? JSON.parse(String(init.body)).method : "beacon";
    return await hooks.request?.(method, init?.signal ?? undefined) ??
      Response.json({ result: bake.recipe.engineMethods, data: {} });
  }) as typeof fetch;
  try {
    await run(network, events, hooks);
  } finally {
    await network.stop();
    globalThis.fetch = originalFetch;
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
    await Deno.remove(bakePath("gloas", tag));
  }
}

function pending<T>(
  signal: AbortSignal | undefined,
  fallback: Promise<T>,
  aborted: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      aborted();
      reject(signal?.reason);
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    void fallback.then(resolve, reject).finally(() => signal?.removeEventListener("abort", stop));
  });
}

Deno.test("already interrupted network startup creates no active generation or clients", async () => {
  await fixture(async (network, events) => {
    await assert.rejects(
      network.start("new", AbortSignal.abort(new Error("startup canceled"))),
      /startup canceled/,
    );
    assert.deepEqual(events, []);
    assert.equal(await network.store.active(), undefined);
  });
});

for (const phase of ["genesis", "eth_chainId", "engine_exchangeCapabilities", "beacon"]) {
  Deno.test(`startup cancellation aborts ${phase} wait before cleanup and creates no later clients`, async () => {
    await fixture(async (network, events, hooks) => {
      const cancel = new AbortController(), entered = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<{ StatusCode: number }>();
      const response = Promise.withResolvers<Response>();
      const methods =
        (await readBake(network.config.profile, network.config.bake)).recipe.engineMethods;
      let interrupted = false;
      if (phase === "genesis") {
        hooks.wait = (role, signal) => {
          if (role !== "genesis") return Promise.resolve({ StatusCode: 0 });
          entered.resolve();
          return pending(signal, finished.promise, () => {
            interrupted = true;
          });
        };
      } else {hooks.request = (method, signal) => {
          if (method !== phase) {
            return Promise.resolve(Response.json({ result: methods, data: {} }));
          }
          entered.resolve();
          return pending(signal, response.promise, () => {
            interrupted = true;
          });
        };}
      const startup = network.start("new", cancel.signal);
      void startup.catch(() => {});
      try {
        await deadline(entered.promise, 1000, "startup reached probe");
        const before = [...events];
        cancel.abort(new Error("startup canceled"));
        await assert.rejects(deadline(startup, 200, "startup cancellation"), /startup canceled/);
        assert.equal(interrupted, true, "cancel the actual request, not only its observer");
        assert.deepEqual(events, [...before, "cleanup"]);
        assert.equal(await network.store.active(), undefined);
        await delay(10);
        assert.deepEqual(events, [...before, "cleanup"], "no late startup after cleanup");
      } finally {
        finished.resolve({ StatusCode: 0 });
        response.resolve(Response.json({ result: [], data: {} }));
        await startup.catch(() => {});
      }
    });
  });
}

Deno.test("startup waits for an in-flight Docker create before cleanup and never starts that client", async () => {
  await fixture(async (network, events, hooks) => {
    const cancel = new AbortController(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    hooks.create = async (role) => {
      if (role === "genesis") {
        entered.resolve();
        await release.promise;
      }
    };
    const startup = network.start("new", cancel.signal);
    void startup.catch(() => {});
    try {
      await entered.promise;
      cancel.abort(new Error("startup canceled"));
      await delay(10);
      assert.equal(events.includes("cleanup"), false, "cleanup must not race container creation");
      release.resolve();
      await assert.rejects(startup, /startup canceled/);
      assert.deepEqual(events, ["network", "genesis:create", "cleanup"]);
      assert.equal(await network.store.active(), undefined);
    } finally {
      release.resolve();
      await startup.catch(() => {});
    }
  });
});

Deno.test("interrupted resume retains the generation as faulted without creating fresh genesis", async () => {
  await fixture(async (network, events) => {
    const bake = await readBake(network.config.profile, network.config.bake);
    const saved = await network.store.create(network.config, bake.key);
    saved.phase = "stopped";
    saved.checkpoint = {
      abi: 1,
      nowMs: network.config.genesisTime * 1000 + 11_500,
      headSlot: 0,
      headBlockRoot: `0x${"ab".repeat(32)}`,
      headStateRoot: `0x${"cd".repeat(32)}`,
      forkChoiceSlot: 0,
      checkpointHash: `0x${"ef".repeat(32)}`,
    };
    await network.store.write(saved);
    const write = network.store.write.bind(network.store), cancel = new AbortController();
    network.store.write = async (value) => {
      await write(value);
      if (value.phase === "starting") cancel.abort(new Error("resume canceled"));
    };
    await assert.rejects(network.start("auto", cancel.signal), /resume canceled/);
    const active = await network.store.active();
    assert.equal(active?.generation, saved.generation);
    assert.equal(active?.phase, "faulted");
    assert.deepEqual(active?.checkpoint, saved.checkpoint);
    assert.deepEqual(events, ["cleanup"]);
    await assert.rejects(network.store.resumable(), /clean|stopped|faulted/i);
  });
});

Deno.test("readiness cancellation wins over a successful probe in the same turn", async () => {
  const cancel = new AbortController();
  await assert.rejects(
    waitFor(
      "startup",
      () => {
        cancel.abort(new Error("stop"));
        return Promise.resolve(true);
      },
      1000,
      cancel.signal,
    ),
    /stop/,
  );
});

Deno.test("readiness passes cancellation to real HTTP and JSON RPC fetches", async () => {
  const seen = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    request.signal.addEventListener("abort", () => closed.resolve(), { once: true });
    seen.resolve();
    await release.promise;
    return Response.json({ result: true });
  });
  const cancel = new AbortController();
  const url = `http://127.0.0.1:${server.addr.port}`;
  const startup = waitFor(
    "RPC readiness",
    (signal) => rpc(url, "eth_chainId", [], signal),
    1000,
    cancel.signal,
  );
  try {
    await seen.promise;
    cancel.abort(new Error("HTTP startup canceled"));
    await assert.rejects(deadline(startup, 200, "real HTTP cancellation"), /HTTP startup canceled/);
    await deadline(closed.promise, 200, "upstream request socket closed");
    await assert.rejects(json(url, { signal: cancel.signal }), /HTTP startup canceled/);
  } finally {
    release.resolve();
    await startup.catch(() => {});
    await server.shutdown();
  }
});
