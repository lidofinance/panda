import assert from "node:assert/strict";
import { BeaconRelay } from "../src/beacon_relay.ts";
import { ConsensusMessages } from "../src/consensus_messages.ts";
import { deadline } from "../src/http.ts";

function validator(pubkey: string) {
  return {
    data: {
      index: "0",
      balance: "32000000000",
      status: "active_ongoing",
      validator: {
        pubkey,
        withdrawal_credentials: `0x${"00".repeat(32)}`,
        effective_balance: "32000000000",
        slashed: false,
        activation_eligibility_epoch: "0",
        activation_epoch: "0",
        exit_epoch: "18446744073709551615",
        withdrawable_epoch: "18446744073709551615",
      },
    },
  };
}

Deno.test("private relay holds PTC duties until the complete validator index pass", async () => {
  const requested = Promise.withResolvers<void>();
  const indices = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const native = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
    requested.resolve();
    return Response.json({ data: [{ validator_index: "0" }] });
  });
  const relay = new BeaconRelay(
    `http://127.0.0.1:${native.addr.port}`,
    new ConsensusMessages(() => 0),
    {
      indexRequest: () => () => {},
      beforeDuties: () => {
        held.resolve();
        return indices.promise;
      },
    },
  );
  let released = false;
  const response = fetch(
    relay.url.replace("host.docker.internal", "127.0.0.1") + "eth/v1/validator/duties/ptc/0",
    { method: "POST", body: '["0"]' },
  ).then((response) => {
    released = true;
    return response;
  });
  try {
    await requested.promise;
    await deadline(held.promise, 100, "PTC response interception");
    assert.equal(released, false, "partial initial indices escaped the relay");
    indices.resolve();
    assert.deepEqual(await (await response).json(), { data: [{ validator_index: "0" }] });
  } finally {
    indices.resolve();
    await (await response).body?.cancel().catch(() => {});
    await relay.close();
    await native.shutdown();
  }
});

Deno.test("private relay reports exact validator-index lookup outcomes including transport failure", async () => {
  const outcomes: [string, number][] = [];
  const key = `0x${"12".repeat(48)}`;
  let status = 404;
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => status === 200 ? Response.json(validator(key)) : new Response("index", { status }),
  );
  const relay = new BeaconRelay(
    `http://127.0.0.1:${native.addr.port}`,
    new ConsensusMessages(() => 0),
    {
      beforeDuties: () => Promise.resolve(),
      indexRequest: (pubkey) => (status) => outcomes.push([pubkey, status]),
    },
  );
  const url = relay.url.replace("host.docker.internal", "127.0.0.1") +
    `eth/v1/beacon/states/head/validators/${key}`;
  try {
    for (const value of [404, 503, 200]) {
      status = value;
      const response = await fetch(url);
      assert.equal(response.status, value);
      await response.arrayBuffer();
    }
    await native.shutdown();
    const response = await fetch(url);
    assert.equal(response.status, 503);
    await response.arrayBuffer();
    assert.deepEqual(outcomes, [[key, 404], [key, 503], [key, 200], [key, 0]]);
  } finally {
    await relay.close();
    await native.shutdown();
  }
});

Deno.test("malformed HTTP 200 index bodies are recorded as failures without changing forwarded bytes", async () => {
  const key = `0x${"12".repeat(48)}`;
  const valid = validator(key);
  const bodies = [
    '{"data":',
    JSON.stringify({ data: { index: "0" } }),
    JSON.stringify({ ...valid, data: { ...valid.data, balance: "not-a-number" } }),
    JSON.stringify(validator(`0x${"34".repeat(48)}`)),
  ];
  let body = "";
  const statuses: number[] = [];
  const native = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response(body, { headers: { "content-type": "application/json" } }),
  );
  const relay = new BeaconRelay(
    `http://127.0.0.1:${native.addr.port}`,
    new ConsensusMessages(() => 0),
    {
      beforeDuties: () => Promise.resolve(),
      indexRequest: () => (status) => statuses.push(status),
    },
  );
  try {
    for (const value of bodies) {
      body = value;
      const response = await fetch(
        relay.url.replace("host.docker.internal", "127.0.0.1") +
          `eth/v1/beacon/states/head/validators/${key}`,
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), body);
    }
    assert.deepEqual(statuses, [0, 0, 0, 0]);
  } finally {
    await relay.close();
    await native.shutdown();
  }
});
