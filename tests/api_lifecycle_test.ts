import assert from "node:assert/strict";
import { Devnet } from "../src/api.ts";
import { Controller } from "../src/controller.ts";

// SDK transport/lifecycle adapter tests. Real checkpoint continuity has its own EL/CL suite.
async function fixture(run: (api: Devnet, calls: string[], replace: () => void) => Promise<void>) {
  const calls: string[] = [];
  let session = 1;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const { method } = await request.json();
    calls.push(method);
    if (method === "lifecycle") {
      return Response.json({
        result: {
          ready: true,
          phase: "ready",
          sessionId: `session-${session}`,
          generation: "generation",
        },
      });
    }
    if (method === "stop") return Response.json({ result: { abi: 1, headSlot: 3 } });
    return Response.json({ result: null });
  });
  const api = new Devnet(`http://127.0.0.1:${server.addr.port}`);
  try {
    await run(api, calls, () => session++);
  } finally {
    await api.close();
    await server.shutdown();
  }
}

Deno.test("borrowed SDK close only disconnects, and stop/resume use lifecycle control", async () => {
  await fixture(async (api, calls) => {
    assert.equal((await api.stop()).headSlot, 3);
    await api.resume();
    await api.close();
    await api.close();
    assert.deepEqual(calls, ["stop", "resume"]);
    await assert.rejects(api.status(), /closed/);
  });
});

Deno.test("owning SDK open requests resume and close destroys its owned controller once", async () => {
  const original = Controller.start;
  const modes: unknown[] = [];
  let closed = 0;
  Controller.start = (_config, mode) => {
    modes.push(mode);
    return Promise.resolve({
      serve: () => "http://127.0.0.1:1",
      close: () => {
        closed++;
        return Promise.resolve();
      },
    } as unknown as Controller);
  };
  try {
    const api = await Devnet.open({ id: "saved" });
    await api.close();
    await api.close();
    assert.deepEqual(modes, ["resume"]);
    assert.equal(closed, 1);
  } finally {
    Controller.start = original;
  }
});

Deno.test("SDK wait rejects a replacement session instead of accepting another branch's success", async () => {
  await fixture(async (api, _calls, replace) => {
    await assert.rejects(
      api.waitForService("oracle", () => {
        replace();
        return Promise.resolve("caught up");
      }, 1000),
      /session changed/,
    );
    await assert.rejects(
      api.advanceUntil(() => {
        replace();
        return Promise.resolve(false);
      }, { maxSlots: 0 }),
      /session changed/,
    );
  });
});

Deno.test("closing borrowed SDK interrupts a hung wait without shutting down the service", async () => {
  await fixture(async (api, calls) => {
    const started = Promise.withResolvers<void>();
    const waiting = api.waitForService("hung oracle", () => {
      started.resolve();
      return new Promise<never>(() => {});
    }, 10_000);
    const failed = assert.rejects(waiting, /closed/);
    await started.promise;
    await api.close();
    await failed;
    assert(!calls.includes("shutdown"));
  });
});

Deno.test("SDK wait notices session replacement while the external probe is hung", async () => {
  await fixture(async (api, _calls, replace) => {
    const started = Promise.withResolvers<void>();
    const waiting = api.waitForService("hung indexer", () => {
      started.resolve();
      return new Promise<never>(() => {});
    }, 1000);
    const failed = assert.rejects(waiting, /session changed/);
    await started.promise;
    replace();
    await failed;
  });
});

Deno.test("SDK open preserves restored data if publishing its local HTTP endpoint fails", async () => {
  const original = Controller.start;
  const calls: string[] = [];
  Controller.start = () =>
    Promise.resolve({
      serve: () => {
        throw new Error("port unavailable");
      },
      close: () => {
        calls.push("destroy");
        return Promise.resolve();
      },
      closePreserving: () => {
        calls.push("preserve");
        return Promise.resolve();
      },
    } as unknown as Controller);
  try {
    await assert.rejects(Devnet.open({ id: "saved" }), /port unavailable/);
    assert.deepEqual(calls, ["preserve"]);
  } finally {
    Controller.start = original;
  }
});
