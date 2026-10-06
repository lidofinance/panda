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

async function executionFixture(
  profile: "gloas" | "pectra",
  upstream: string,
  run: (f: { controller: Controller; url: string; network: Network }) => Promise<void>,
) {
  const config = configuration({
    id: `execution-${profile}`,
    profile,
    bake: profile === "gloas" ? "snapshot-minimal-r1" : "default",
  });
  const network = new Network(config);
  const controller = new Controller(network, {
    config,
    bake: await readBake(config.profile, config.bake),
    el: upstream,
  } as Manifest, new Timeline(0, 11500, { move: async () => {} }));
  const url = controller.serve(0);
  try {
    await run({ controller, url, network });
  } finally {
    await controller.server!.shutdown();
    await controller.automine.stop();
  }
}
const rpcBody = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });

Deno.test("a lost mutation response body after HTTP headers keeps the session and its outcome", async () => {
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
  try {
    await executionFixture(
      "gloas",
      `http://127.0.0.1:${upstream.addr.port}`,
      async ({ controller, url, network }) => {
        const response = await fetch(url, {
          method: "POST",
          body: rpcBody("eth_sendRawTransaction"),
        });
        const body = response.text();
        fail.resolve();
        await assert.rejects(body);
        // Geth answered after processing the submission; its pool decides any later capture.
        assert.equal(controller.lifecycle().ready, true);
        assert.deepEqual(network.consensusMessages!.snapshot(), []);
      },
    );
  } finally {
    fail.resolve();
    await upstream.shutdown();
  }
});

for (const profile of ["pectra", "gloas"] as const) {
  Deno.test(`${profile}: an aborted read-only JSON-RPC call never faults ingress`, async () => {
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (r) => {
      const call = await r.json();
      if (call.method === "eth_call") {
        received.resolve();
        await release.promise;
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
    });
    try {
      await executionFixture(
        profile,
        `http://127.0.0.1:${upstream.addr.port}`,
        async ({ controller, url, network }) => {
          const abort = new AbortController();
          const call = fetch(url, {
            method: "POST",
            body: rpcBody("eth_call"),
            signal: abort.signal,
          });
          await received.promise;
          abort.abort();
          await assert.rejects(call);
          release.resolve();
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(controller.lifecycle().ready, true, "a read faulted the session");
          const next = await fetch(url, { method: "POST", body: rpcBody("eth_blockNumber") });
          assert.equal(next.status, 200);
          await next.text();
          if (network.consensusMessages) assert.deepEqual(network.consensusMessages.snapshot(), []);
        },
      );
    } finally {
      release.resolve();
      await upstream.shutdown();
    }
  });
}

Deno.test("a disconnected client cannot make a delivered transaction submission uncertain", async () => {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (r) => {
    await r.arrayBuffer();
    received.resolve();
    await release.promise;
    queueMicrotask(answered.resolve);
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x12" });
  });
  try {
    await executionFixture(
      "gloas",
      `http://127.0.0.1:${upstream.addr.port}`,
      async ({ controller, url, network }) => {
        const abort = new AbortController();
        const call = fetch(url, {
          method: "POST",
          body: rpcBody("eth_sendRawTransaction"),
          signal: abort.signal,
        });
        await received.promise;
        abort.abort();
        await assert.rejects(call);
        release.resolve();
        await answered.promise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(controller.lifecycle().ready, true);
        assert.equal(controller.ingress.status.active, 0, "submission lease leaked");
        assert.deepEqual(network.consensusMessages!.snapshot(), []);
      },
    );
  } finally {
    release.resolve();
    await upstream.shutdown();
  }
});

for (const profile of ["pectra", "gloas"] as const) {
  Deno.test(`${profile}: an undeliverable submission refuses snapshots but keeps the network usable`, async () => {
    const closed = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      () => new Response(),
    );
    const endpoint = `http://127.0.0.1:${closed.addr.port}`;
    await closed.shutdown();
    await executionFixture(profile, endpoint, async ({ controller, url, network }) => {
      const response = await fetch(url, {
        method: "POST",
        body: rpcBody("eth_sendRawTransaction"),
      });
      assert.notEqual(response.status, 200);
      await response.text();
      assert.equal(controller.lifecycle().ready, true, "uncertainty disabled the whole network");
      if (network.consensusMessages) {
        assert.throws(() => network.consensusMessages!.snapshot(), /uncertain/);
      }
    });
  });
}

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

async function partialUpload(url: string, path = "/") {
  const address = new URL(url);
  const connection = await Deno.connect({ hostname: address.hostname, port: Number(address.port) });
  await connection.write(new TextEncoder().encode(
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jsonrpc":"2.0"`,
  ));
  return connection;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

Deno.test("an interrupted EL upload changes nothing and keeps snapshots available", async () => {
  await executionFixture("gloas", "http://127.0.0.1:1", async ({ controller, url, network }) => {
    const connection = await partialUpload(url);
    await settle();
    connection.close();
    await settle();
    assert.equal(controller.lifecycle().ready, true);
    assert.equal(controller.ingress.status.active, 0, "aborted upload kept its lease");
    assert.deepEqual(network.consensusMessages!.snapshot(), [], "nothing was forwarded");
  });
});

Deno.test("a stalled EL upload releases its lease when Panda cancels pending requests", async () => {
  await executionFixture("gloas", "http://127.0.0.1:1", async ({ controller, url }) => {
    const connection = await partialUpload(url);
    try {
      await settle();
      assert.equal(controller.ingress.status.active, 1);
      controller.ingress.cancelPending(new Error("drain deadline"));
      await settle();
      assert.equal(controller.ingress.status.active, 0, "a stalled client blocks drain forever");
    } finally {
      connection.close();
    }
  });
});

Deno.test("read-only Beacon POST failures never refuse snapshots", async () => {
  await executionFixture("gloas", "http://127.0.0.1:1", async ({ controller, url, network }) => {
    (controller.manifest as { beacon: string }).beacon = "http://127.0.0.1:1";
    const response = await fetch(`${url}/eth/v1/validator/duties/attester/0`, {
      method: "POST",
      body: '["0"]',
    });
    await response.text();
    assert.equal(controller.lifecycle().ready, true);
    assert.deepEqual(network.consensusMessages!.snapshot(), []);
  });
});

Deno.test("a faulted timeline keeps reads available and rejects every later mutation", async () => {
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (r) => {
    await r.arrayBuffer();
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1", data: { root: "0x12" } });
  });
  const endpoint = `http://127.0.0.1:${upstream.addr.port}`;
  const config = configuration({
    id: "faulted-reads",
    profile: "gloas",
    bake: "snapshot-minimal-r1",
  });
  const controller = new Controller(
    new Network(config),
    {
      config,
      bake: await readBake(config.profile, config.bake),
      el: endpoint,
      beacon: endpoint,
    } as Manifest,
    new Timeline(0, 11500, {
      move: () => Promise.reject(new Error("broken signer barrier")),
    }),
  );
  const url = controller.serve(0);
  const call = async (method: string) => {
    const response = await fetch(`${url}/control`, {
      method: "POST",
      body: JSON.stringify({ method, params: [] }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.match((await call("stepSlot")).body.error, /broken signer barrier/);
    assert.equal((await call("resources")).status, 200, "status reads were blocked");
    const head = await fetch(`${url}/eth/v1/beacon/headers/head`);
    assert.equal(head.status, 200, "Beacon reads were blocked");
    await head.text();
    const read = await fetch(url, { method: "POST", body: rpcBody("eth_blockNumber") });
    assert.equal(read.status, 200, "JSON-RPC reads were blocked");
    await read.text();
    assert.match((await call("stepSlot")).body.error, /reset required/);
    assert.equal(controller.lifecycle().recoveryRequired, true);
    await assert.rejects(controller.createSnapshot(), /reset required|faulted|ingress/);
  } finally {
    await controller.server!.shutdown();
    await controller.automine.stop();
    await upstream.shutdown();
  }
});
