import assert from "node:assert/strict";
import { Consensus } from "../src/consensus.ts";
import type { EngineGate } from "../src/engine.ts";
import { type Manifest, Network } from "../src/network.ts";
import { PtcReadiness } from "../src/ptc_readiness.ts";
import { configuration } from "../src/config.ts";
import type { BeaconRelay } from "../src/beacon_relay.ts";

function controlledManifest(capable = true): Manifest {
  return {
    config: { profile: "gloas", mode: "controlled", genesisTime: 0 },
    bake: { recipe: { ptcReadiness: capable, clockWait: true } },
    bnClock: "http://127.0.0.1/bn",
    vcClock: "http://127.0.0.1/vc",
  } as unknown as Manifest;
}

Deno.test("PTC timer must be selected before any slot-boundary clock or Engine mutation", async () => {
  const engine = { nowMs: 3 * 12_000 + 11_500 } as EngineGate;
  const consensus = new Consensus(controlledManifest(), engine);
  const events: string[] = [];
  consensus.mark = (_endpoint, names, slot) => {
    events.push(`${names.join(",")}=${slot}`);
    return Promise.reject(new Error("PTC timer not selected"));
  };
  consensus.clock = () => {
    events.push("clock advance");
    return Promise.reject(new Error("clock moved too soon"));
  };
  await assert.rejects(consensus.move(4 * 12_000, 0), /PTC timer not selected/);
  assert.deepEqual(events, ["ptc_wait=4"]);
  assert.equal(engine.nowMs, 3 * 12_000 + 11_500);
});

Deno.test("PTC timer target is exact at every boundary and uses the replacement VC endpoint", async () => {
  const manifest = controlledManifest();
  const consensus = new Consensus(manifest);
  const events: string[] = [];
  consensus.mark = (endpoint, names, slot) => {
    events.push(`${endpoint}:${names.join(",")}=${slot}`);
    return Promise.resolve();
  };
  consensus.clock = () => Promise.reject(new Error("stop after timer gate"));
  await assert.rejects(consensus.move(4 * 12_000, 0), /stop after timer gate/);
  manifest.vcClock = "http://127.0.0.1/replacement";
  await assert.rejects(consensus.move(128 * 12_000, 0), /stop after timer gate/);
  assert.deepEqual(events, [
    "http://127.0.0.1/vc:ptc_wait=4",
    "http://127.0.0.1/replacement:ptc_wait=128",
  ]);
});

Deno.test("legacy bakes retain their clock ordering without the PTC capability", async () => {
  const consensus = new Consensus(controlledManifest(false));
  consensus.mark = () => Promise.reject(new Error("unexpected PTC gate"));
  consensus.clock = () => Promise.reject(new Error("legacy clock advance"));
  await assert.rejects(consensus.move(4 * 12_000, 0), /legacy clock advance/);
});

Deno.test("capable connect and skip reject a missing bootstrap runtime before any side effects", async () => {
  const fetch = globalThis.fetch;
  const skip = Network.prototype.skipValidator;
  let requests = 0;
  let skips = 0;
  globalThis.fetch = () => {
    requests++;
    return Promise.resolve(Response.json({ nowMs: 47_500, marks: {} }));
  };
  Network.prototype.skipValidator = () => {
    skips++;
    return Promise.resolve();
  };
  const engine = { nowMs: 47_500 } as EngineGate;
  try {
    await assert.rejects(Consensus.connect(controlledManifest(), engine), /bootstrap runtime/);
    await assert.rejects(
      new Consensus(controlledManifest(), engine).skip(95_500),
      /bootstrap runtime/,
    );
    assert.equal(requests, 0);
    assert.equal(skips, 0);
    assert.equal(engine.nowMs, 47_500);
  } finally {
    globalThis.fetch = fetch;
    Network.prototype.skipValidator = skip;
  }
});

async function readinessFixture(
  run: (fixture: {
    readiness: PtcReadiness;
    manifest: Manifest;
    state: { indices: boolean; metrics: number[]; lookupStatus: number };
    requests: string[];
    clockRequested: Promise<void>;
    metricsRequested: Promise<void>;
  }) => Promise<void>,
) {
  const directory = await Deno.makeTempDir({ prefix: "panda-ptc-unit-" });
  await Deno.mkdir(`${directory}/validator-keys/keys`, { recursive: true });
  await Deno.writeTextFile(`${directory}/validator-keys/keys/api-token.txt`, "unit-token");
  const manifest = {
    ...controlledManifest(),
    directory,
    beacon: "http://127.0.0.1/bn",
    vc: "http://127.0.0.1/vc-api",
    vcMetrics: "http://127.0.0.1/vc-metrics",
  };
  const state = { indices: true, metrics: [4, 6], lookupStatus: 200 };
  const requests: string[] = [];
  const clock = Promise.withResolvers<void>();
  const metrics = Promise.withResolvers<void>();
  const fetch = globalThis.fetch;
  const pubkeys = ["11", "22", "33"].map((hex) => `0x${hex.repeat(48)}`);
  const respond = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === manifest.vcClock) {
      clock.resolve();
      return Response.json({
        nowMs: 3 * 12_000 + 11_500,
        marks: { ready: 0, ...(state.indices ? { indices: 3 } : {}) },
      });
    }
    if (url.endsWith("/eth/v1/keystores")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer unit-token");
      return Response.json({ data: pubkeys.map((validating_pubkey) => ({ validating_pubkey })) });
    }
    if (url.includes("/states/head/validators/")) {
      const index = pubkeys.indexOf(url.split("/").at(-1)!);
      assert.notEqual(index, -1);
      const status = index === 2 ? 404 : state.lookupStatus;
      return Response.json({ data: { index: String(index) } }, { status });
    }
    if (url.includes("/duties/ptc/")) {
      assert.equal(init?.body, '["0","1"]', "query every registered owned index");
      const next = url.endsWith("/1");
      return Response.json({ data: Array(next ? 6 : 4).fill({}) });
    }
    if (url.endsWith("/metrics")) {
      metrics.resolve();
      return new Response(
        ["current_epoch", "next_epoch"].map((task, index) =>
          `vc_beacon_ptc_count{task="${task}"} ${state.metrics[index]}`
        ).join("\n"),
      );
    }
    throw new Error(`Unexpected unit request: ${url}`);
  };
  globalThis.fetch = (input, init) => Promise.resolve(respond(input, init));
  const readiness = new PtcReadiness(150);
  readiness.bind(manifest);
  try {
    await run({
      readiness,
      manifest,
      state,
      requests,
      clockRequested: clock.promise,
      metricsRequested: metrics.promise,
    });
  } finally {
    readiness.close();
    globalThis.fetch = fetch;
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("delayed index discovery holds duties; legitimate unregistered keys remain allowed", async () => {
  await readinessFixture(async ({ readiness, state, clockRequested }) => {
    state.indices = false;
    readiness.indexRequest(`0x${"33".repeat(48)}`)(404);
    let complete = false;
    const waiting = readiness.beforeDuties().then(() => complete = true);
    await clockRequested;
    assert.equal(complete, false);
    state.indices = true;
    await waiting;
  });
});

Deno.test("an index completion mark cannot conceal a failed VC index request", async () => {
  for (const status of [0, 429, 500]) {
    await readinessFixture(async ({ readiness }) => {
      readiness.indexRequest(`0x${"11".repeat(48)}`)(status);
      await assert.rejects(readiness.beforeDuties(), /index discovery failed/);
    });
  }
});

Deno.test("partial and initially empty PTC caches wait for complete current and next duty rows", async () => {
  for (const initial of [[0, 0], [2, 3], [4, 0]]) {
    await readinessFixture(async ({ readiness, state, requests, metricsRequested }) => {
      state.metrics = initial;
      let complete = false;
      const waiting = readiness.beforePtcDeadline(4).then(() => complete = true);
      await metricsRequested;
      assert.equal(complete, false);
      state.metrics = [4, 6];
      await waiting;
      assert.equal(requests.filter((url) => url.includes("/duties/ptc/")).length, 2);
    });
  }
});

Deno.test("native non-404 owned-index lookup errors prevent declaring duty-cache readiness", async () => {
  await readinessFixture(async ({ readiness, state, requests }) => {
    state.lookupStatus = 503;
    await assert.rejects(readiness.beforePtcDeadline(4), /503/);
    assert(!requests.some((url) => url.endsWith("/metrics")));
  });
});

Deno.test("cache mismatch fails before Engine or either protocol clock reaches the PTC deadline", async () => {
  await readinessFixture(async ({ readiness, manifest, state }) => {
    state.metrics = [4, 5];
    const engine = { nowMs: 4 * 12_000 + 6_000 } as EngineGate;
    const consensus = new Consensus(manifest, engine, { ptcReadiness: readiness } as Network);
    consensus.clock = () => Promise.reject(new Error("protocol time changed before cache ready"));
    await assert.rejects(consensus.move(4 * 12_000 + 9_000, 9_000), /cache rows|TimeoutError/);
    assert.equal(engine.nowMs, 4 * 12_000 + 6_000);
  });
});

Deno.test("replacement invalidates cached readiness and ignores delayed old lookup outcomes", async () => {
  await readinessFixture(async ({ readiness, manifest, state, requests }) => {
    await readiness.beforePtcDeadline(4);
    const oldOutcome = readiness.indexRequest(`0x${"11".repeat(48)}`);
    readiness.reset();
    manifest.vcClock = "http://127.0.0.1/new-vc";
    manifest.vcMetrics = "http://127.0.0.1/new-metrics";
    readiness.bind(manifest);
    oldOutcome(500);
    state.metrics = [0, 0];
    await assert.rejects(readiness.beforePtcDeadline(4), /cache rows|TimeoutError/);
    assert(requests.includes(manifest.vcClock));
    assert(requests.includes(`${manifest.vcMetrics}/metrics`));
    assert.equal(requests.filter((url) => url.endsWith("/eth/v1/keystores")).length, 2);
  });
});

Deno.test("replacement cancels a previous VC's pending discovery barrier", async () => {
  await readinessFixture(async ({ readiness, state, clockRequested }) => {
    state.indices = false;
    const waiting = readiness.beforeDuties();
    await clockRequested;
    readiness.reset();
    await assert.rejects(waiting, /replaced or closed/);
  });
});

Deno.test("skip replacement resets bootstrap before start and binds new VC metrics and clock", async () => {
  const network = new Network(configuration({
    id: `unit-ptc-${crypto.randomUUID().slice(0, 8)}`,
    profile: "gloas",
    mode: "controlled",
    genesisTime: 0,
  }));
  await Deno.mkdir(network.directory, { recursive: true });
  const manifest = {
    ...controlledManifest(),
    config: network.config,
    directory: network.directory,
    beacon: "http://127.0.0.1/new-bn",
    bake: { recipe: { ptcReadiness: true, clockEnvPrefix: "PANDA" } },
  } as unknown as Manifest;
  const events: string[] = [];
  const readiness = new PtcReadiness(150);
  const reset = readiness.reset.bind(readiness);
  readiness.reset = () => {
    events.push("reset");
    reset();
  };
  network.ptcReadiness = readiness;
  network.beaconRelay = { upstream: "old-bn" } as BeaconRelay;
  const { infra } = network;
  infra.docker.listContainers = ((options) => {
    assert(options && typeof options !== "function");
    assert.deepEqual(options?.filters, {
      label: [`io.panda.id=${network.config.id}`, "io.panda.role=vc"],
    });
    return Promise.resolve([{ Id: "unit-old-vc" }]);
  }) as typeof infra.docker.listContainers;
  infra.docker.getContainer = (() => ({
    inspect: () =>
      Promise.resolve({
        Image: "unit-image",
        Config: {
          Env: ["PANDA_CLOCK_START_MS=11500"],
          Cmd: ["validator_client", "--disable-payload-available-monitor"],
          ExposedPorts: { "5059/tcp": {}, "5062/tcp": {}, "5064/tcp": {} },
        },
        HostConfig: {},
      }),
    stop: () => {
      events.push("stop");
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  })) as unknown as typeof infra.docker.getContainer;
  infra.container = ((_role, options) => {
    assert.deepEqual(options.Cmd, ["validator_client", "--disable-payload-available-monitor"]);
    return Promise.resolve({
      start: () => {
        events.push("start");
        return Promise.resolve();
      },
      inspect: () =>
        Promise.resolve({
          NetworkSettings: {
            Ports: Object.fromEntries(
              [5059, 5062, 5064].map((port) => [
                `${port}/tcp`,
                [{ HostPort: String(port + 10_000) }],
              ]),
            ),
          },
        }),
    });
  }) as typeof infra.container;
  const fetch = globalThis.fetch;
  const nowMs = 127 * 12_000 + 11_500;
  globalThis.fetch =
    (() =>
      Promise.resolve(Response.json({ nowMs, marks: { ready: 0, indices: 127 } }))) as typeof fetch;
  try {
    await network.skipValidator(manifest, nowMs);
    assert.deepEqual(events, ["stop", "reset", "start"]);
    assert.equal(manifest.vcClock, "http://127.0.0.1:15059");
    assert.equal(manifest.vc, "http://127.0.0.1:15062");
    assert.equal(manifest.vcMetrics, "http://127.0.0.1:15064");
    assert.equal(network.beaconRelay.upstream, manifest.beacon);
  } finally {
    readiness.close();
    globalThis.fetch = fetch;
    await Deno.remove(network.directory, { recursive: true });
  }
});
