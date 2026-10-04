import assert from "node:assert/strict";
import { Controller } from "../src/controller.ts";
import { configuration } from "../src/config.ts";
import type { Manifest, Network } from "../src/network.ts";
import { Timeline } from "../src/time.ts";

Deno.test("lifecycle status is available without any live execution or beacon client", async () => {
  const controller = new Controller({} as Network, {
    config: configuration({ id: "status-fixture" }),
    el: "http://127.0.0.1:1",
    beacon: "http://127.0.0.1:1",
  } as Manifest, new Timeline(0, 11_500, { move: async () => {} }));
  const result = await controller.command("lifecycle") as { id: string; ready: boolean };
  assert.equal(result.id, "status-fixture");
  assert.equal(result.ready, true);
});
