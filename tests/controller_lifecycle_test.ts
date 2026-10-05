/** Controller/admission adapter checks. Real client continuation is tested in gloas/tests/resume.ts. */
import assert from "node:assert/strict";
import { AdmissionLedger, pinnedGethRevision } from "../src/admission.ts";
import { Controller } from "../src/controller.ts";
import { configuration } from "../src/config.ts";
import type { Manifest, Network } from "../src/network.ts";
import { StateStore } from "../src/storage.ts";
import { Timeline } from "../src/time.ts";

async function fixture(run: (c: Controller, time: Timeline) => Promise<void>, accepted = true) {
  const base = await Deno.makeTempDir();
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  const config = configuration({ id: "lifecycle-adapter" });
  const store = new StateStore(config.id);
  const generation = await store.create(config, "ab".repeat(32));
  generation.phase = "running";
  await store.write(generation);
  const ledger = await AdmissionLedger.open(`${store.root}/admission.json`, {
    gethRevision: pinnedGethRevision,
  });
  const hash = `0x${"12".repeat(32)}`;
  if (accepted) {
    await ledger.forward(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [{}] }),
      () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: hash })),
    );
  }
  const checkpoint = {
    abi: 1 as const,
    nowMs: config.genesisTime * 1000 + 11_500,
    headSlot: 0,
    headBlockRoot: hash,
    headStateRoot: hash,
    forkChoiceSlot: 1,
    checkpointHash: hash,
  };
  const upstream = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (r) => {
    if (new URL(r.url).pathname === "/park") {
      return Response.json({ parked: true, activeWork: 0, nowMs: checkpoint.nowMs });
    }
    if (new URL(r.url).pathname === "/lighthouse/panda/checkpoint") {
      return Response.json(checkpoint);
    }
    const call = await r.json();
    const result = call.method === "eth_getBlockByNumber"
      ? { hash: `0x${"34".repeat(32)}`, number: "0x0" }
      : call.method === "txpool_status"
      ? { pending: "0x0", queued: "0x0" }
      : null;
    return Response.json({ jsonrpc: "2.0", id: call.id, result });
  });
  const time = new Timeline(config.genesisTime * 1000, config.genesisTime * 1000 + 11_500, {
    move: async () => {},
  });
  const network = {
    store,
    generation,
    preserve: async (receipt: typeof checkpoint) => {
      generation.phase = "stopped";
      generation.checkpoint = receipt;
      await store.write(generation);
    },
    stop: async () => {
      await store.destroy(generation);
    },
  } as unknown as Network;
  const c = new Controller(
    network,
    {
      config,
      generation: generation.generation,
      el: `http://127.0.0.1:${upstream.addr.port}`,
      beacon: `http://127.0.0.1:${upstream.addr.port}`,
      bnClock: `http://127.0.0.1:${upstream.addr.port}`,
      vcClock: `http://127.0.0.1:${upstream.addr.port}`,
      bake: { recipe: { checkpointAbi: 1 } },
    } as Manifest,
    time,
    ledger,
  );
  try {
    await run(c, time);
  } finally {
    await c.close();
    await upstream.shutdown();
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("checkpoint refusal leaves accepted work usable and restores automine without advancing time", async () => {
  await fixture(async (c, time) => {
    c.automine.candidates = () => Promise.resolve([]);
    await c.automine.set(true);
    const before = time.nowMs;
    await assert.rejects(c.preserve(), /unresolved/);
    assert.equal(c.lifecycle().ready, true);
    assert.equal(c.lifecycle().operation?.state, "failed");
    assert.equal(c.automine.enabled, true);
    assert.equal(time.nowMs, before);
    await c.command("advanceSlots", [1]);
    assert.equal(time.slot, 1);
  });
});

Deno.test("completed stop result remains queryable and durable when its HTTP response is lost", async () => {
  await fixture(async (c) => {
    const result = await c.preserve();
    const operation = c.lifecycle().operation as unknown as Record<string, unknown>;
    assert.equal(operation.state, "succeeded");
    assert.deepEqual(operation.result, result);
    assert.deepEqual(
      JSON.parse(await Deno.readTextFile(`${c.network.store.root}/operation.json`)),
      operation,
    );
    assert.equal(c.lifecycle().ready, false);
  }, false);
});

Deno.test("baseline sessions cannot advertise or attempt controlled checkpoints", async () => {
  await fixture(async (c) => {
    c.manifest.config.mode = "baseline";
    assert.equal(c.lifecycle().checkpointCapable, false);
    await assert.rejects(c.preserve(), /checkpoint capability/);
    assert.equal(c.lifecycle().ready, true);
    assert.equal(c.lifecycle().operation, undefined);
  });
});

Deno.test("request drain failure is recorded as a failed lifecycle operation", async () => {
  await fixture(async (c) => {
    const original = Deno.env.get("PANDA_TIMEOUT_MS");
    Deno.env.set("PANDA_TIMEOUT_MS", "30");
    const lease = c.ingress.enter();
    try {
      await assert.rejects(c.preserve(), /request drain/);
      assert.equal(c.lifecycle().operation?.state, "failed");
      const saved = JSON.parse(await Deno.readTextFile(`${c.network.store.root}/operation.json`));
      assert.equal(saved.state, "failed");
      assert.match(saved.error, /request drain/);
      assert.equal(c.lifecycle().ready, false);
    } finally {
      lease.release();
      if (original === undefined) Deno.env.delete("PANDA_TIMEOUT_MS");
      else Deno.env.set("PANDA_TIMEOUT_MS", original);
    }
  });
});

Deno.test("maintenance drains an accepted advance without holding its Timeline lock", async () => {
  await fixture(async (c, time) => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    time.backend.move = async () => {
      entered.resolve();
      await release.promise;
    };
    const advance = c.command("advanceSlots", [1]);
    await entered.promise;
    const refused = assert.rejects(c.preserve(), /unresolved/);
    assert.equal(c.lifecycle().ready, false);
    assert.equal(c.lifecycle().operation?.name, "stop");
    await assert.rejects(c.command("advanceSlots", [1]), /maintenance/);
    await assert.rejects(c.preserve(), /in progress/);
    release.resolve();
    await advance;
    await refused;
    assert.equal(c.lifecycle().ready, true);
    assert.equal(time.slot, 1);
  });
});

Deno.test("non-tail checkpoint is refused before native work and a faulted Timeline stays closed", async () => {
  await fixture(async (c, time) => {
    time.nowMs++;
    await assert.rejects(c.preserve(), /completed slot tail/);
    assert.equal(c.lifecycle().ready, true);
    time.backend.move = () => Promise.reject(new Error("native phase failed"));
    await assert.rejects(c.command("advanceSlots", [1]), /native phase failed/);
    assert.equal(c.lifecycle().ready, false);
    assert.equal(c.lifecycle().phase, "faulted");
    assert.equal((await c.command("lifecycle") as { ready: boolean }).ready, false);
  });
});
