/** Public controller adapter tests; real database restoration is checked separately. */
import assert from "node:assert/strict";
import { Controller } from "../src/controller.ts";
import { configuration } from "../src/config.ts";
import { type Manifest, Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { Timeline } from "../src/time.ts";

Deno.test("snapshot management and lifecycle inspection do not require live clients", async () => {
  const base = await Deno.makeTempDir();
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  const config = configuration({
    profile: "gloas",
    bake: "snapshot-minimal-r1",
    id: "public-unit",
  });
  const network = new Network(config);
  const controller = new Controller(
    network,
    {
      config,
      bake: await readBake(config.profile, config.bake),
      el: "http://127.0.0.1:1",
    } as Manifest,
    new Timeline(config.genesisTime * 1000, config.genesisTime * 1000 + 11500, {
      move: () => Promise.reject(new Error("management must not move time")),
    }),
  );
  const url = controller.serve(0);
  const call = async (method: string, params: unknown[] = []) => {
    const response = await fetch(`${url}/control`, {
      method: "POST",
      body: JSON.stringify({ method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const lifecycle = await call("lifecycle");
    assert.equal(lifecycle.status, 200, JSON.stringify(lifecycle.body));
    assert.equal(lifecycle.body.result.ready, true);
    assert.equal(lifecycle.body.result.id, config.id);
    assert.deepEqual((await call("snapshotList")).body.result, []);
    const invalid = await call("snapshotCreate", ["../../escape"]);
    assert.equal(invalid.status, 500);
    assert.match(invalid.body.error, /UUID/);
    assert.equal((await call("lifecycle")).body.result.ready, true);
  } finally {
    await controller.server!.shutdown();
    await controller.automine.stop();
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("lost mutation response body faults the session even after HTTP headers arrived", async () => {
  const fail = Promise.withResolvers<void>();
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    void request.arrayBuffer();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"result":'));
          void fail.promise.then(() => controller.error(new Error("lost acknowledgement")));
        },
      }),
    );
  });
  const config = configuration({
    id: "lost-response",
    profile: "gloas",
    bake: "snapshot-minimal-r1",
  });
  const controller = new Controller(new Network(config), {
    config,
    bake: await readBake(config.profile, config.bake),
    el: `http://127.0.0.1:${upstream.addr.port}`,
  } as Manifest, new Timeline(0, 11500, { move: async () => {} }));
  const url = controller.serve(0);
  try {
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: ["0x12"],
      }),
    });
    const body = response.text();
    fail.resolve();
    await assert.rejects(body);
    const state = await controller.command("lifecycle") as { ready: boolean };
    assert.equal(
      state.ready,
      false,
      "an uncertain submission must not permit a subsequent snapshot",
    );
  } finally {
    fail.resolve();
    await controller.server!.shutdown();
    await upstream.shutdown();
  }
});

Deno.test("graceful shutdown retains destructive cleanup for clients without snapshot support", async () => {
  let stopped = false;
  const config = configuration({ profile: "pectra", id: "legacy-close" });
  const controller = new Controller({
    config,
    stop: () => {
      stopped = true;
      return Promise.resolve();
    },
  } as unknown as Network, {
    config,
    bake: await readBake("pectra", "default"),
    el: "http://127.0.0.1:1",
  } as Manifest, new Timeline(0, 11500, { move: async () => {} }));
  await controller.closePreserving();
  assert.equal(stopped, true);
});
