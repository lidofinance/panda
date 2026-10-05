import assert from "node:assert/strict";
import { PandaClient } from "../src/client.ts";
import type { ControlRequest, TimeState } from "../src/api_contract.ts";

Deno.test("HTTP client imports independently and returns typed wire results", async () => {
  const source = await Deno.readTextFile("src/client.ts");
  assert(!/from ["']\.\/(controller|network|snapshot_archive|http)\.ts/.test(source));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { method: "advanceTime", params: [12] });
      return Promise.resolve(Response.json({ result: { now: 12, slot: 1 } }));
    };
    const client = new PandaClient("http://127.0.0.1:8545");
    const state: TimeState = await client.advanceTime(12);
    assert.deepEqual(state, { now: 12, slot: 1 });
    await client.close();
  } finally {
    globalThis.fetch = original;
  }
});

// Compile-time contract checks: each command retains its positional argument types.
const valid: ControlRequest = { method: "advanceTime", params: [12, { mode: "fast" }] };
// @ts-expect-error Duration is numeric.
const wrong: ControlRequest = { method: "advanceTime", params: ["12"] };
// @ts-expect-error Restore requires snapshot and operation IDs.
const missing: ControlRequest = { method: "snapshotRestore" };
void [valid, wrong, missing];
