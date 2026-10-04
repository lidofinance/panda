import assert from "node:assert/strict";
import { Controller } from "../src/controller.ts";
import type { Bake } from "../src/profiles.ts";
import {
  startServiceController,
  stopServiceController,
  waitForServiceDocker,
} from "../container/service.ts";
import { health } from "../container/health.ts";
import { deadline } from "../src/http.ts";
import { StateStore } from "../src/storage.ts";
import { configuration } from "../src/config.ts";

Deno.test("container imports its seed only before the first active generation", async () => {
  const previous = Object.fromEntries(
    ["PANDA_DATA_DIR", "PANDA_SNAPSHOT", "PANDA_SNAPSHOT_SHA256"].map((
      name,
    ) => [name, Deno.env.get(name)]),
  );
  const base = await Deno.makeTempDir();
  Deno.env.set("PANDA_DATA_DIR", base);
  Deno.env.set("PANDA_SNAPSHOT", "https://example.org/fixture.gz");
  Deno.env.set("PANDA_SNAPSHOT_SHA256", "ab".repeat(32));
  const originals = { start: Controller.start, fromSnapshot: Controller.fromSnapshot };
  const calls: unknown[] = [];
  const controller = {} as Controller;
  Controller.start = (...args) => {
    calls.push(["start", ...args]);
    return Promise.resolve(controller);
  };
  Controller.fromSnapshot = (...args) => {
    calls.push(["snapshot", ...args]);
    return Promise.resolve(controller);
  };
  const signal = new AbortController().signal;
  const bake = { profile: "gloas", tag: "pinned" } as Bake;
  try {
    assert.equal(await startServiceController(bake, signal), controller);
    assert.deepEqual(calls[0], [
      "snapshot",
      "https://example.org/fixture.gz",
      "service",
      undefined,
      { bake: "pinned", sha256: "ab".repeat(32), signal },
    ]);
    const store = new StateStore("service");
    const active = await store.create(
      configuration({ id: "service", profile: "gloas", bake: "pinned" }),
      "ab".repeat(32),
    );
    for (const phase of ["starting", "running", "faulted", "stopped"] as const) {
      await store.write({ ...active, phase });
      await startServiceController(bake, signal);
      assert.deepEqual(calls.at(-1), [
        "start",
        { id: "service", profile: "gloas", bake: "pinned" },
        "auto",
        signal,
      ]);
    }
    await assert.rejects(startServiceController(bake, AbortSignal.abort()));
    assert.equal(calls.length, 5);
  } finally {
    Object.assign(Controller, originals);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await Deno.remove(base, { recursive: true });
  }
});

for (const interruption of ["SIGTERM", "daemon exit"] as const) {
  Deno.test(`container startup ${interruption} interrupts a hanging readiness probe and enters cleanup`, async () => {
    const signal = new AbortController();
    const daemonExit = Promise.withResolvers<{ code: number }>();
    const ping = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let probes = 0;
    let cleaned = false;
    const startup = (async () => {
      try {
        await waitForServiceDocker(
          () => {
            probes++;
            started.resolve();
            return ping.promise;
          },
          signal.signal,
          daemonExit.promise,
          1000,
        );
      } finally {
        cleaned = true;
      }
    })();
    try {
      await started.promise;
      if (interruption === "SIGTERM") signal.abort();
      else daemonExit.resolve({ code: 7 });
      await assert.rejects(
        deadline(startup, 200, "startup cancellation"),
        interruption === "SIGTERM"
          ? /Docker startup interrupted/
          : /Docker exited during startup: 7/,
      );
      assert.equal(cleaned, true);
      assert.equal(probes, 1, "interrupted startup must not retry readiness");
    } finally {
      ping.resolve();
      await startup.catch(() => {});
    }
  });
}

Deno.test("container startup cancellation wins over a simultaneously successful ping", async () => {
  const signal = new AbortController();
  await assert.rejects(
    waitForServiceDocker(
      () => {
        signal.abort();
        return Promise.resolve();
      },
      signal.signal,
      new Promise(() => {}),
      1000,
    ),
    /Docker startup interrupted/,
  );
});

Deno.test("container startup retries transient ping failures and bounds a hanging daemon", async () => {
  const signal = new AbortController();
  const daemonExit = new Promise<{ code: number }>(() => {});
  let attempts = 0;
  await waitForServiceDocker(
    () => {
      return ++attempts === 1 ? Promise.reject(new Error("not ready")) : Promise.resolve();
    },
    signal.signal,
    daemonExit,
    1000,
  );
  assert.equal(attempts, 2);
  await assert.rejects(
    waitForServiceDocker(() => new Promise(() => {}), signal.signal, daemonExit, 10),
    /Timed out: private Docker daemon/,
  );
});

Deno.test("container uses a stable owner and auto resume; persistent shutdown never calls destroy", async () => {
  const original = Controller.start;
  const calls: unknown[] = [];
  let capable = true;
  const controller = {
    lifecycle: () => ({ checkpointCapable: capable }),
    close: () => {
      calls.push("destroy");
      return Promise.resolve();
    },
    closePreserving: () => {
      calls.push("preserve");
      return Promise.resolve();
    },
  } as unknown as Controller;
  Controller.start = (config, mode) => {
    calls.push({ config, mode });
    return Promise.resolve(controller);
  };
  try {
    const result = await startServiceController({ profile: "gloas", tag: "checkpoint" } as Bake);
    assert.equal(result, controller);
    await stopServiceController(result);
    capable = false;
    await stopServiceController(result);
    assert.deepEqual(calls, [
      { config: { id: "service", profile: "gloas", bake: "checkpoint" }, mode: "auto" },
      "preserve",
      "destroy",
    ]);
  } finally {
    Controller.start = original;
  }
});

Deno.test("container health refuses maintenance without querying stopped clients", async () => {
  const calls: string[] = [];
  let ready = false;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const { method } = await request.json();
    calls.push(method);
    if (method === "lifecycle") {
      return Response.json({
        result: { ready, phase: ready ? "ready" : "parked", sessionId: "same" },
      });
    }
    return Response.json({ result: { el: { hash: "0xhead" }, finality: { data: {} } } });
  });
  try {
    const url = `http://127.0.0.1:${server.addr.port}`;
    await assert.rejects(health(url, 1000), /parked/);
    assert.deepEqual(calls, ["lifecycle"]);
    ready = true;
    await health(url, 1000);
    assert.deepEqual(calls, ["lifecycle", "lifecycle", "status", "lifecycle"]);
  } finally {
    await server.shutdown();
  }
});
