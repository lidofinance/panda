import assert from "node:assert/strict";
import { Automine } from "../src/automine.ts";
import { configuration } from "../src/config.ts";
import { Consensus } from "../src/consensus.ts";
import { deadline } from "../src/http.ts";
import type { Manifest } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { Timeline } from "../src/time.ts";

// Real HTTP cancellation with adapter responses; this does not simulate consensus acceptance.
async function hungRequest(
  run: (url: string, entered: Promise<void>, requests: string[]) => Promise<void>,
) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    requests.push(new URL(request.url).pathname);
    entered.resolve();
    await release.promise;
    return Response.json({ nowMs: 12_000, marks: {}, result: { pending: {} } });
  });
  try {
    await run(`http://127.0.0.1:${server.addr.port}`, entered.promise, requests);
  } finally {
    release.resolve();
    await server.shutdown();
  }
}

for (const operation of ["clock", "native barrier", "execution agreement"] as const) {
  Deno.test(`discarding a Timeline cancels its in-flight ${operation} without further requests`, async () => {
    await hungRequest(async (url, entered, requests) => {
      const manifest = {
        config: configuration(),
        bake: await readBake("gloas", "p3-checkpoint-r5"),
        bnClock: url,
        vcClock: url,
        beacon: url,
        el: url,
      } as Manifest;
      const backend = new Consensus(manifest);
      const time = new Timeline(0, 11_500, backend);
      const work = operation === "clock"
        ? time.stepSlot()
        : operation === "native barrier"
        ? time.exclusive(() => backend.mark(url, ["slot"], 1))
        : time.exclusive(() => backend.consistency(1));
      const outcome = work.then(() => undefined, (error: unknown) => error);
      try {
        await deadline(entered, 1000, "adapter request started");
        time.stop();
        const error = await deadline(outcome, 1000, "cancelled session drains");
        assert.match(String(error), /stopp|cancel|discard/i);
        await deadline(time.queue.idle(), 1000, "old queue drains");
        await assert.rejects(time.stepSlot(), /stopping/);
        assert.equal(requests.length, 1);
      } finally {
        // The fixture server releases its hung response after this callback returns.
        void outcome;
      }
    });
  });
}

Deno.test("discarding automine cancels an in-flight pool read and never starts a block", async () => {
  await hungRequest(async (url, entered, requests) => {
    let moves = 0;
    const time = new Timeline(0, 11_500, {
      move: () => {
        moves++;
        return Promise.resolve();
      },
    });
    const automine = new Automine(url, time);
    await automine.set(true);
    await deadline(entered, 1000, "automine pool read started");
    await deadline(automine.stop(), 1000, "automine cancellation drains");
    assert.equal(automine.enabled, false);
    assert.equal(moves, 0);
    assert.equal(requests.length, 1);
  });
});
