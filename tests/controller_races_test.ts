/** Controller concurrency checks with real HTTP and storage, adapter clients, and no Docker. */
import assert from "node:assert/strict";
import { AdmissionLedger, pinnedGethRevision } from "../src/admission.ts";
import { configuration } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import { deadline, waitFor } from "../src/http.ts";
import type { Manifest, Network } from "../src/network.ts";
import { type Checkpoint, StateStore } from "../src/storage.ts";
import { Timeline } from "../src/time.ts";

const hash = `0x${"12".repeat(32)}`;
const sender = `0x${"34".repeat(20)}`;
type Hooks = {
  mutation: () => Promise<void>;
  move: (at: number, phase?: number) => Promise<void>;
  save: () => Promise<void>;
  pending: boolean;
};

async function fixture(
  run: (context: {
    controller: Controller;
    time: Timeline;
    ledger: AdmissionLedger;
    hooks: Hooks;
    events: string[];
    url: string;
  }) => Promise<void>,
) {
  const base = await Deno.makeTempDir({ prefix: "panda-controller-races-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  const config = configuration({ id: "race-adapter" });
  const store = new StateStore(config.id);
  const generation = await store.create(config, "ab".repeat(32));
  generation.phase = "running";
  await store.write(generation);
  const directory = `${store.generationPath(generation.generation)}/shared`;
  await Deno.mkdir(`${directory}/validator-keys/keys`, { recursive: true });
  await Deno.writeTextFile(`${directory}/validator-keys/keys/api-token.txt`, "adapter-token");
  const ledger = await AdmissionLedger.open(`${store.root}/admission.json`, {
    gethRevision: pinnedGethRevision,
  });
  const events: string[] = [];
  const hooks: Hooks = {
    mutation: () => Promise.resolve(),
    move: () => Promise.resolve(),
    save: () => Promise.resolve(),
    pending: false,
  };
  const time = new Timeline(config.genesisTime * 1000, config.genesisTime * 1000 + 11_500, {
    move: async (at, phase) => {
      events.push(`move:${phase}`);
      await hooks.move(at, phase);
    },
  });
  const receipt = (): Checkpoint => ({
    abi: 1,
    nowMs: time.nowMs,
    headSlot: time.slot,
    headBlockRoot: hash,
    headStateRoot: hash,
    forkChoiceSlot: time.slot,
    checkpointHash: hash,
  });
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/eth/v1/keystores" || path === "/eth/v1/beacon/pool/voluntary_exits") {
        await request.json();
        events.push("import-started");
        await hooks.mutation();
        events.push("import-committed");
        return Response.json({ data: [{ status: "imported" }] });
      }
      if (path === "/park") {
        events.push("park");
        return Response.json({ parked: true, activeWork: 0, nowMs: time.nowMs });
      }
      if (path === "/lighthouse/panda/checkpoint") return Response.json(receipt());
      const call = await request.json();
      const head = {
        hash,
        number: `0x${time.slot.toString(16)}`,
        gasLimit: "0x100000",
        gasUsed: "0x80000",
        baseFeePerGas: "0x1",
      };
      const result = call.method === "txpool_content"
        ? {
          pending: hooks.pending
            ? {
              [sender]: {
                "0": {
                  hash,
                  from: sender,
                  nonce: "0x0",
                  gas: "0x5208",
                  value: "0x1",
                  gasPrice: "0x2",
                },
              },
            }
            : {},
        }
        : call.method === "eth_getBlockByNumber"
        ? head
        : call.method === "eth_getTransactionCount"
        ? "0x0"
        : call.method === "eth_getBalance"
        ? "0xffffff"
        : call.method === "txpool_status"
        ? { pending: "0x0", queued: "0x0" }
        : null;
      return Response.json({ jsonrpc: "2.0", id: call.id, result });
    },
  );
  const endpoint = `http://127.0.0.1:${upstream.addr.port}`;
  const network = {
    store,
    generation,
    preserve: async (checkpoint: Checkpoint) => {
      events.push("save-started");
      generation.phase = "stopping";
      await store.write(generation);
      await hooks.save();
      generation.phase = "stopped";
      generation.checkpoint = checkpoint;
      await store.write(generation);
      events.push("save-finished");
    },
    stop: async () => {
      events.push("destroy");
      await store.destroy(generation);
    },
  } as unknown as Network;
  const controller = new Controller(
    network,
    {
      config,
      directory,
      generation: generation.generation,
      el: endpoint,
      beacon: endpoint,
      vc: endpoint,
      bnClock: endpoint,
      vcClock: endpoint,
      bake: { recipe: { checkpointAbi: 1 } },
    } as Manifest,
    time,
    ledger,
  );
  const url = controller.serve(0);
  try {
    await run({ controller, time, ledger, hooks, events, url });
  } finally {
    await controller.close();
    await upstream.shutdown();
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("save drains accepted CL and VC imports before parking and rejects later imports", async (t) => {
  for (const entrypoint of ["CL", "VC", "control importValidator"]) {
    await t.step(entrypoint, () =>
      fixture(async ({ controller, time, hooks, events, url }) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        hooks.mutation = () => {
          entered.resolve();
          return release.promise;
        };
        const endpoint = entrypoint === "CL"
          ? `${url}/cl/eth/v1/beacon/pool/voluntary_exits`
          : entrypoint === "VC"
          ? `${url}/vc/eth/v1/keystores`
          : `${url}/control`;
        const init = {
          method: "POST",
          body: JSON.stringify(
            entrypoint === "control importValidator"
              ? {
                method: "importValidator",
                params: [
                  JSON.stringify({ version: 4, pubkey: "ab".repeat(48) }),
                  "adapter-password",
                ],
              }
              : {},
          ),
          signal: AbortSignal.timeout(3000),
        };
        const imported = fetch(endpoint, init).then(async (response) => {
          assert.equal(response.status, 200, await response.text());
        });
        await deadline(entered.promise, 1000, "import entered upstream");
        const before = time.nowMs;
        let saved = false;
        const saving = controller.preserve().then((checkpoint) => {
          saved = true;
          return checkpoint;
        });
        try {
          assert.equal(controller.lifecycle().ready, false);
          const refused = await fetch(endpoint, init);
          assert.equal(refused.status, 503, await refused.text());
          assert.equal(saved, false);
          assert(!events.includes("park"), "native work parked before the accepted import drained");
          assert.equal(events.filter((event) => event === "import-started").length, 1);
        } finally {
          release.resolve();
        }
        await deadline(Promise.all([imported, saving]), 2000, "save after import");
        assert(events.indexOf("import-committed") < events.indexOf("park"));
        assert.equal(time.nowMs, before);
        assert.equal(controller.lifecycle().phase, "parked");
      }));
  }
});

Deno.test("save waits for an active automine slot without holding the Timeline lock", async () => {
  await fixture(async ({ controller, time, ledger, hooks, events }) => {
    // Keep this receipt unresolved so the save refuses before native consensus checks. This
    // test proves controller drain order, not execution inclusion or real client continuation.
    await ledger.forward(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [{}] }),
      () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: hash })),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hooks.pending = true;
    hooks.move = async (_at, phase) => {
      if (phase === 0) {
        entered.resolve();
        await release.promise;
      }
      if (phase === 11_500) hooks.pending = false;
    };
    await controller.automine.set(true);
    await deadline(entered.promise, 1000, "automine entered a real Timeline slot");
    let finished = false;
    const saving = assert.rejects(controller.preserve(), /EL submissions unresolved/).then(() => {
      finished = true;
    });
    try {
      await waitFor(
        "save disables active automine",
        () => Promise.resolve(!controller.automine.enabled || undefined),
        1000,
      );
      assert.equal(finished, false);
      assert.equal(time.slot, 0);
      await assert.rejects(controller.command("stepSlot"), /maintenance/);
    } finally {
      release.resolve();
    }
    await deadline(saving, 2000, "save drains active automine");
    assert.equal(time.slot, 1);
    assert.deepEqual(events.filter((event) => event.startsWith("move:")), [
      "move:0",
      "move:4000",
      "move:6000",
      "move:8000",
      "move:9000",
      "move:11500",
    ]);
    assert(!events.includes("park"));
    assert.equal(controller.lifecycle().ready, true);
    assert.equal(controller.automine.enabled, true);
    await controller.automine.set(false);
    assert.equal(time.slot, 1, "refused save produced an additional automine slot");
  });
});

for (const shutdown of ["destructive", "preserving"] as const) {
  Deno.test(`${shutdown} shutdown waits for an already active save without starting it twice`, async () => {
    await fixture(async ({ controller, hooks, events }) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      hooks.save = () => {
        entered.resolve();
        return release.promise;
      };
      const saving = controller.preserve();
      await deadline(entered.promise, 1000, "save entered persistence");
      let shutdownFinished = false;
      const closing =
        (shutdown === "preserving" ? controller.closePreserving() : controller.close()).then(
          () => {
            shutdownFinished = true;
            return undefined;
          },
          (error: unknown) => {
            shutdownFinished = true;
            return error;
          },
        );
      // Give shutdown an event-loop turn while the controlled persistence operation is held.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const completedBeforeSave = shutdownFinished;
      const destroyedBeforeSave = events.includes("destroy");
      release.resolve();
      await deadline(saving, 2000, "original save completes");
      const error = await deadline(closing, 2000, "shutdown after save");
      assert.equal(error, undefined, "shutdown rejected instead of awaiting the accepted save");
      assert.equal(completedBeforeSave, false, "shutdown returned before its checkpoint finished");
      assert.equal(destroyedBeforeSave, false);
      assert.equal(events.filter((event) => event === "save-started").length, 1);
      assert.equal(events.filter((event) => event === "save-finished").length, 1);
      assert.equal(
        events.filter((event) => event === "destroy").length,
        shutdown === "destructive" ? 1 : 0,
      );
      if (shutdown === "destructive") {
        assert(events.indexOf("save-finished") < events.indexOf("destroy"));
      } else {
        assert.equal((await controller.network.store.active())?.phase, "stopped");
      }
    });
  });
}

Deno.test("simultaneous preserving shutdown callers share one checkpoint and completion", async () => {
  await fixture(async ({ controller, hooks, events }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hooks.save = () => {
      entered.resolve();
      return release.promise;
    };
    const first = controller.closePreserving();
    const second = controller.closePreserving();
    let finished = false;
    const joined = Promise.all([first, second]).then(() => {
      finished = true;
    });
    try {
      await deadline(entered.promise, 1000, "single preserving shutdown starts save");
      assert.equal(first, second, "parallel callers started independent shutdowns");
      assert.equal(finished, false);
      assert.equal(events.filter((event) => event === "save-started").length, 1);
    } finally {
      release.resolve();
    }
    await deadline(joined, 2000, "both shutdown callers await same checkpoint");
    await controller.closePreserving();
    assert.equal(events.filter((event) => event === "save-started").length, 1);
    assert.equal(events.filter((event) => event === "save-finished").length, 1);
    assert.equal(events.includes("destroy"), false);
    assert.equal((await controller.network.store.active())?.phase, "stopped");
  });
});

Deno.test("preserving shutdown propagates an active save failure without retry or destroy", async () => {
  await fixture(async ({ controller, hooks, events }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error("adapter persistence failed");
    hooks.save = async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    };
    const saving = assert.rejects(controller.preserve(), (error) => error === failure);
    await deadline(entered.promise, 1000, "existing save awaits persistence");
    let completed = false;
    const closing = assert.rejects(controller.closePreserving(), (error) => error === failure)
      .then(() => {
        completed = true;
      });
    await Promise.resolve();
    assert.equal(completed, false, "shutdown finished before learning the save outcome");
    release.resolve();
    await deadline(Promise.all([saving, closing]), 2000, "failed save propagates to shutdown");
    assert.equal(events.filter((event) => event === "save-started").length, 1);
    assert.equal(events.includes("save-finished"), false);
    assert.equal(events.includes("destroy"), false);
    assert.notEqual((await controller.network.store.active())?.phase, "stopped");
    assert.equal(controller.lifecycle().operation?.state, "failed");
    assert.match(controller.lifecycle().operation!.error!, /adapter persistence failed/);
    await assert.rejects(controller.closePreserving(), (error) => error === failure);
    assert.equal(events.filter((event) => event === "save-started").length, 1);
  });
});

Deno.test("preserving shutdown claims maintenance before a same-turn later save can enter", async () => {
  await fixture(async ({ controller, hooks, events }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hooks.save = () => {
      entered.resolve();
      return release.promise;
    };
    const closing = controller.closePreserving().then(
      () => undefined,
      (error: unknown) => error,
    );
    const wasReady = controller.lifecycle().ready;
    const laterSave = controller.preserve().then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await deadline(entered.promise, 1000, "one lifecycle operation enters persistence");
    } finally {
      release.resolve();
    }
    const [shutdownError, saveError] = await deadline(
      Promise.all([closing, laterSave]),
      2000,
      "reverse-order save/shutdown race",
    );
    assert.equal(shutdownError, undefined, "a later save stole ownership from requested shutdown");
    assert.match(String(saveError), /Another lifecycle operation is in progress/);
    assert.equal(wasReady, false, "shutdown yielded before closing admission");
    assert.equal(events.filter((event) => event === "save-started").length, 1);
    assert.equal(events.filter((event) => event === "save-finished").length, 1);
    assert.equal(events.includes("destroy"), false);
    assert.equal((await controller.network.store.active())?.phase, "stopped");
  });
});
