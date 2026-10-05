import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import type { EngineGate } from "../src/engine.ts";
import { type Manifest, Network } from "../src/network.ts";
import { StateLock, StateStore } from "../src/storage.ts";
import { Timeline } from "../src/time.ts";

Deno.test("failed fallback stop releases ownership when durable metadata cannot be read", async () => {
  const base = await Deno.makeTempDir({ prefix: "panda-stop-failure-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  const config = configuration({ id: "failed-stop" });
  const store = new StateStore(config.id);
  const value = await store.create(config, "ab".repeat(32));
  const network = new Network(config);
  network.saveLogs = () => Promise.resolve();
  network.infra.cleanup = () => Promise.resolve();
  try {
    await Deno.writeTextFile(`${store.root}/active.json`, "{");
    await assert.rejects(network.stop(), SyntaxError);
    const recovered = await StateLock.acquire(`${store.root}/network.lock`);
    recovered.release();
  } finally {
    await store.write(value);
    await network.stop();
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("an asynchronous automine advancement fault closes lifecycle readiness and ingress", async () => {
  const entered = Promise.withResolvers<void>();
  const time = new Timeline(0, 11_500, {
    move: () => {
      entered.resolve();
      return Promise.reject(new Error("native automine phase failed"));
    },
  });
  const controller = new Controller(
    { stop: () => Promise.resolve() } as unknown as Network,
    { config: configuration({ id: "automine-failure" }), el: "http://127.0.0.1:1" } as Manifest,
    time,
  );
  controller.automine.candidates = () => Promise.resolve(["pending-transaction"]);
  try {
    await controller.command("setAutomine", [true]);
    await entered.promise;
    await controller.automine.set(false);
    assert.throws(() => time.assertHealthy(), /native automine phase failed/);
    assert.equal(controller.lifecycle().ready, false);
    assert.equal(controller.lifecycle().phase, "faulted");
    assert.throws(() => controller.ingress.enter(), /faulted/);
  } finally {
    await controller.close();
  }
});

Deno.test("failed resume still closes its engine and clients when saving diagnostic logs fails", async () => {
  const network = new Network(configuration({ id: "failed-resume-cleanup" }));
  const calls: string[] = [];
  network.saveLogs = () => {
    calls.push("logs");
    return Promise.reject(new Error("diagnostic disk full"));
  };
  network.engine = {
    close: () => {
      calls.push("engine");
      return Promise.resolve();
    },
  } as unknown as EngineGate;
  network.infra.cleanup = () => {
    calls.push("clients");
    return Promise.resolve();
  };
  await assert.rejects(network.fail(new Error("native receipt mismatch")), /diagnostic disk full/);
  assert.deepEqual(calls, ["logs", "engine", "clients"]);
});
