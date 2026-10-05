import assert from "node:assert/strict";
import { ConsensusMessages } from "../src/consensus_messages.ts";
import { Controller } from "../src/controller.ts";
import { configuration } from "../src/config.ts";
import type { Manifest, Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";
import { BeaconRelay } from "../src/beacon_relay.ts";
import { deadline } from "../src/http.ts";

Deno.test("managed public Beacon submissions participate in snapshot capture", async () => {
  const native = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    await request.arrayBuffer();
    return new Response(null);
  });
  const endpoint = `http://127.0.0.1:${native.addr.port}`;
  const messages = new ConsensusMessages(() => 3);
  const controller = new Controller({ consensusMessages: messages } as unknown as Network, {
    config: configuration(),
    el: endpoint,
    beacon: endpoint,
  } as Manifest, new Timeline(0, 47_500, { move: async () => {} }));
  const url = controller.serve(0);
  try {
    const response = await fetch(`${url}/eth/v1/beacon/pool/payload_attestations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '[{"data":{"slot":"3"}}]',
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(messages.snapshot().length, 1, "public ingress bypassed capture");
  } finally {
    await controller.server!.shutdown();
    await controller.automine.stop();
    await native.shutdown();
  }
});

Deno.test("private relay shutdown closes an idle validator connection", async () => {
  const stop = new AbortController();
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: stop.signal, onListen() {} },
    () => new Response(null),
  );
  const relay = new BeaconRelay(
    `http://127.0.0.1:${native.addr.port}`,
    new ConsensusMessages(() => 3),
  );
  const connection = await Deno.connect({ hostname: "127.0.0.1", port: relay.server.addr.port });
  try {
    await deadline(relay.close(), 100, "relay shutdown with idle socket");
  } finally {
    connection.close();
    await relay.close();
    stop.abort();
    await native.finished;
  }
});

Deno.test("private relay shutdown cancels a live Beacon event stream", async () => {
  const stop = new AbortController();
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: stop.signal, onListen() {} },
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: head\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const relay = new BeaconRelay(
    `http://127.0.0.1:${native.addr.port}`,
    new ConsensusMessages(() => 3),
  );
  const response = await fetch(
    relay.url.replace("host.docker.internal", "127.0.0.1") + "eth/v1/events?topics=head",
  );
  try {
    await deadline(relay.close(), 100, "relay shutdown with event stream");
  } finally {
    await response.body?.cancel().catch(() => {});
    stop.abort();
    await native.finished;
    await relay.close();
  }
});

Deno.test("private VC relay requires its session prefix and captures original signed traffic", async () => {
  const paths: string[] = [];
  const native = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    paths.push(new URL(request.url).pathname);
    await request.arrayBuffer();
    return new Response(null);
  });
  const messages = new ConsensusMessages(() => 3);
  const relay = new BeaconRelay(`http://127.0.0.1:${native.addr.port}`, messages);
  const local = relay.url.replace("host.docker.internal", "127.0.0.1");
  try {
    const forbidden = await fetch(
      `http://127.0.0.1:${relay.server.addr.port}/eth/v1/beacon/genesis`,
    );
    assert.equal(forbidden.status, 403);
    await forbidden.arrayBuffer();
    assert.equal(paths.length, 0);
    const response = await fetch(`${local}eth/v1/beacon/pool/payload_attestations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '[{"data":{"slot":"3"},"signature":"unchanged"}]',
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.deepEqual(paths, ["/eth/v1/beacon/pool/payload_attestations"]);
    assert.equal(messages.snapshot().length, 1);
  } finally {
    await relay.close();
    await native.shutdown();
  }
});
