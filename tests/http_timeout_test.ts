import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { Consensus } from "../src/consensus.ts";
import { deadline, delay, HttpError, json } from "../src/http.ts";
import type { Manifest } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";

async function fixture(
  timeoutMs: number,
  handler: () => Promise<Response>,
  run: (url: string) => Promise<void>,
) {
  const previous = Deno.env.get("PANDA_TIMEOUT_MS");
  Deno.env.set("PANDA_TIMEOUT_MS", String(timeoutMs));
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
  try {
    await run(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    await server.shutdown();
    if (previous === undefined) Deno.env.delete("PANDA_TIMEOUT_MS");
    else Deno.env.set("PANDA_TIMEOUT_MS", previous);
  }
}

async function manifest(url: string): Promise<Manifest> {
  return {
    config: configuration({ id: "http-startup", mode: "controlled" }),
    bnClock: url,
    vcClock: url,
    el: url,
    beacon: url,
    vc: url,
    directory: "fixture",
    bake: await readBake("gloas", "panda"),
  };
}

Deno.test("explicit HTTP deadline can outlive the default to observe the server's domain failure", async () => {
  await fixture(20, async () => {
    await delay(75);
    return new Response("Incomplete native barrier: sync_contributions_7", { status: 503 });
  }, async (url) => {
    await assert.rejects(
      json(url, { signal: AbortSignal.timeout(1000) }),
      (error) =>
        error instanceof HttpError && error.status === 503 &&
        /Incomplete native barrier: sync_contributions_7/.test(error.message),
    );
  });
});

Deno.test("startup clock reads retain a watchdog with a non-expiring caller cancellation signal", async () => {
  await fixture(30, async () => {
    await delay(150);
    return Response.json({ nowMs: 2_000_000_011_500, marks: {} });
  }, async (url) => {
    const startup = Consensus.connect(await manifest(url), undefined, new AbortController().signal);
    try {
      await assert.rejects(
        deadline(startup, 500, "startup watchdog regression"),
        (error) => error instanceof DOMException && error.name === "TimeoutError",
      );
    } finally {
      await startup.then((time) => time.stop(), () => {});
    }
  });
});

Deno.test("startup watchdog remains per request rather than a new total startup deadline", async () => {
  let requests = 0;
  await fixture(200, async () => {
    requests++;
    await delay(125);
    return Response.json({ nowMs: 2_000_000_011_500, marks: {} });
  }, async (url) => {
    const time = await Consensus.connect(
      await manifest(url),
      undefined,
      new AbortController().signal,
    );
    assert.equal(requests, 2);
    assert.equal(time.nowMs, 2_000_000_011_500);
    time.stop();
  });
});
