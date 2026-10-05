import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { AdmissionLedger, pinnedGethRevision } from "../src/admission.ts";
import { configuration } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import { waitFor } from "../src/http.ts";
import { Ingress } from "../src/ingress.ts";
import type { Manifest, Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";

const hash = `0x${"ab".repeat(32)}`;
const submission = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "eth_sendTransaction",
  params: [{ from: `0x${"12".repeat(20)}`, nonce: "0x0" }],
});
const result = { jsonrpc: "2.0", id: 7, result: hash };

function compressed(value: unknown): Response {
  const bytes = new Uint8Array(gzipSync(JSON.stringify(value)));
  return new Response(bytes, {
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(bytes.length),
      "x-upstream-marker": "retained",
    },
  });
}

// Real HTTP transport and gzip bytes, with an adapter network: no Docker or consensus claims.
async function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  run: (controller: Controller, upstream: string, ledger: AdmissionLedger) => Promise<void>,
) {
  const directory = await Deno.makeTempDir();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
  const url = `http://127.0.0.1:${server.addr.port}`;
  const ledger = await AdmissionLedger.open(`${directory}/admission.json`, {
    gethRevision: pinnedGethRevision,
  });
  const controller = new Controller(
    { stop: async () => {} } as unknown as Network,
    {
      config: configuration({ id: "compression-adapter" }),
      el: url,
      beacon: url,
      vc: url,
      bake: { recipe: { checkpointAbi: 1 } },
    } as Manifest,
    new Timeline(0, 11_500, { move: async () => {} }),
    ledger,
  );
  try {
    await run(controller, url, ledger);
  } finally {
    await controller.close();
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("gzip upstream responses survive every managed EL, CL and VC frontend", async (t) => {
  await fixture(() => compressed(result), async (controller, _upstream, ledger) => {
    const main = controller.serve(0);
    const cl = controller.serveClient("beacon");
    const vc = controller.serveClient("vc");
    const read = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "txpool_content", params: [] });
    for (
      const [name, url, body] of [
        ["EL read", main, read],
        ["EL ledger submission", main, submission],
        ["SDK CL", `${main}/cl/eth/v1/beacon/headers/head`, undefined],
        ["legacy CL", `${main}/eth/v1/beacon/headers/head`, undefined],
        ["public CL", `${cl}/eth/v1/beacon/headers/head`, undefined],
        ["SDK VC", `${main}/vc/eth/v1/keystores`, undefined],
        ["public VC", `${vc}/eth/v1/keystores`, undefined],
      ] as const
    ) {
      await t.step(name, async () => {
        const response = await fetch(url, {
          method: body ? "POST" : "GET",
          body,
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), result);
        assert.equal(response.headers.get("x-upstream-marker"), "retained");
      });
    }
    assert.equal(ledger.records[0].state, "accepted");
    assert.equal(ledger.records[0].hash, hash);
  });
});

Deno.test("ledger ACK has decoded representation headers before any ingress wrapping", async () => {
  await fixture(() => compressed(result), async (_controller, upstream, ledger) => {
    const response = await ledger.forward(submission, () =>
      fetch(upstream, {
        method: "POST",
        body: submission,
      }));
    assert.deepEqual(await response.json(), result);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("x-upstream-marker"), "retained");
    assert.equal(ledger.records[0].state, "accepted");
  });
});

Deno.test("wrapping a locally constructed encoded body preserves its representation headers", async () => {
  const original = compressed(result);
  const headers = new Headers(original.headers);
  const expected = new Uint8Array(await original.clone().arrayBuffer());
  const gate = new Ingress();
  const response = gate.holdResponse(original, gate.enter());
  assert.equal(response.headers.get("content-encoding"), headers.get("content-encoding"));
  assert.equal(response.headers.get("content-length"), headers.get("content-length"));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected);
  assert.equal(gate.status.active, 0);
});

Deno.test("gzip SSE forwards its first event before EOF and drains on maintenance", async () => {
  let canceled = false;
  const event = 'data: {"slot":"1"}\n\n';
  await fixture(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Withhold the gzip trailer so the upstream representation remains unfinished.
          // The decoder can already emit the first event without closing the SSE stream.
          controller.enqueue(gzipSync(event).subarray(0, -8));
        },
        cancel() {
          canceled = true;
        },
      }),
      {
        headers: { "content-type": "text/event-stream", "content-encoding": "gzip" },
      },
    ), async (controller) => {
    const endpoint = `${controller.serve(0)}/cl/eth/v1/events?topics=head`;
    const response = await fetch(endpoint, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(3000),
    });
    const reader = response.body!.getReader();
    try {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "SSE was buffered until EOF");
      assert.equal(new TextDecoder().decode(chunk.value), event);
      assert.equal(controller.ingress.status.streams, 1);
      await controller.ingress.maintenance("replace", () => Promise.resolve(), 1000);
      assert.equal(controller.ingress.status.streams, 0);
      await waitFor(
        "upstream gzip SSE cancellation",
        () => Promise.resolve(canceled || undefined),
        1000,
      );
      await assert.rejects(reader.read());
    } finally {
      await reader.cancel().catch(() => {});
    }
  });
});
