import assert from "node:assert/strict";
import { Controller } from "../src/controller.ts";
import { waitFor } from "../src/http.ts";
import { configuration } from "../src/config.ts";
import type { Manifest, Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";

Deno.test("every managed frontend rejects a foreign browser origin before forwarding", async () => {
  let forwarded = 0;
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
    forwarded++;
    return Response.json({ ok: true });
  });
  const url = `http://127.0.0.1:${upstream.addr.port}`;
  const controller = new Controller({ stop: async () => {} } as unknown as Network, {
    config: configuration({ id: "frontend-adapter" }),
    el: url,
    beacon: url,
    vc: url,
    bake: { recipe: { checkpointAbi: 1 } },
  } as Manifest, new Timeline(0, 11_500, { move: async () => {} }));
  try {
    const endpoints = [
      `${controller.serve(0)}/cl/eth/v1/node/health`,
      `${controller.serveClient("beacon")}/eth/v1/node/health`,
      `${controller.serveClient("vc")}/lighthouse/health`,
    ];
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, { headers: { origin: "https://unrelated.example" } });
      await response.arrayBuffer();
      assert.equal(response.status, 403, endpoint);
    }
    assert.equal(forwarded, 0);
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    assert.equal(forwarded, 3);
    for (const path of ["/eth/v1/remotekeys", "/lighthouse/validators/web3signer"]) {
      const response = await fetch(`${controller.serveClient("vc")}${path}`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(response.status, 400, await response.text());
    }
    assert.equal(forwarded, 3, "remote signing must not enter a checkpoint-capable session");
  } finally {
    await controller.close();
    await upstream.shutdown();
  }
});

Deno.test("maintenance timeout cancels a stalled incoming EL body before any upstream submission", async () => {
  let forwarded = 0;
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
    forwarded++;
    return Response.json({ result: "unexpected" });
  });
  const controller = new Controller({} as Network, {
    config: configuration(),
    el: `http://127.0.0.1:${upstream.addr.port}`,
  } as Manifest, new Timeline(0, 11_500, { move: () => Promise.resolve() }));
  const url = controller.serve(0);
  const cancel = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const request = fetch(url, {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(stream) {
        source = stream;
        stream.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
      },
    }),
    signal: cancel.signal,
  }).then((response) => response.text()).catch(() => "canceled");
  try {
    await waitFor("incoming request admitted", () => {
      return Promise.resolve(controller.ingress.status.active === 1 ? true : undefined);
    }, 1000);
    await assert.rejects(
      controller.ingress.maintenance("test drain", () => Promise.resolve(), 10),
      /drain/,
    );
    await waitFor("incoming body canceled after drain timeout", () => {
      return Promise.resolve(controller.ingress.status.active === 0 ? true : undefined);
    }, 100);
    assert.equal(forwarded, 0);
  } finally {
    cancel.abort();
    source.error(new Error("end audit upload"));
    await request;
    await controller.server!.shutdown();
    await controller.automine.stop();
    await upstream.shutdown();
  }
});
