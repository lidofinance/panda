import assert from "node:assert/strict";
import { Ingress } from "../src/ingress.ts";

Deno.test("maintenance rejects new work immediately and drains an accepted response body", async () => {
  const gate = new Ingress();
  const lease = gate.enter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = gate.holdResponse(
    new Response(
      new ReadableStream({
        start(controller) {
          source = controller;
        },
      }),
    ),
    lease,
  );
  let entered = false;
  const stopped = gate.maintenance("stop", () => {
    entered = true;
    return Promise.resolve();
  }, 1000);
  assert.throws(() => gate.enter(), /maintenance/);
  assert.equal(entered, false);
  source.enqueue(new TextEncoder().encode("accepted"));
  source.close();
  assert.equal(await response.text(), "accepted");
  await stopped;
  assert.equal(entered, true);
  assert.equal(gate.status.phase, "parked");
  assert.throws(() => gate.enter(), /parked/);
  gate.resume();
  gate.enter().release();
});

Deno.test("maintenance aborts streams, serializes lifecycle and leaves timeout faulted", async () => {
  const gate = new Ingress();
  const stream = gate.stream();
  stream.signal.addEventListener("abort", () => stream.release(), { once: true });
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = gate.maintenance("first", async () => {
    order.push("first");
    await release.promise;
  });
  const second = gate.maintenance("second", () => {
    order.push("second");
    return Promise.resolve();
  });
  assert.equal(stream.signal.aborted, true);
  await Promise.resolve();
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
  gate.resume();
  const hung = gate.enter();
  let invoked = false;
  await assert.rejects(
    gate.maintenance("hung", () => {
      invoked = true;
      return Promise.resolve();
    }, 10),
    /drain/,
  );
  assert.equal(invoked, false);
  assert.equal(hung.signal.aborted, true);
  assert.equal(gate.status.active, 1, "timeout must not pretend upstream work completed");
  assert.equal(gate.status.phase, "faulted");
  assert.throws(() => gate.resume(), /active/);
  hung.release();
  gate.resume();
});

Deno.test("canceling a downstream body waits for upstream cancellation before releasing its lease", async () => {
  const gate = new Ingress();
  const finishCancel = Promise.withResolvers<void>();
  const response = gate.holdResponse(
    new Response(
      new ReadableStream({
        cancel: () => finishCancel.promise,
      }),
    ),
    gate.enter(),
  );
  const cancellation = response.body!.cancel();
  assert.equal(gate.status.active, 1);
  finishCancel.resolve();
  await cancellation;
  assert.equal(gate.status.active, 0);
});

Deno.test("maintenance closes an idle SSE body without waiting for the consumer to read", async () => {
  const gate = new Ingress();
  let canceled = false;
  const response = gate.holdResponse(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    ),
    gate.stream(),
  );
  await gate.maintenance("replace", () => Promise.resolve());
  assert.equal(canceled, true, "upstream SSE must be canceled on replacement");
  assert.equal(gate.status.streams, 0);
  await assert.rejects(response.text(), /maintenance/);
});

Deno.test("session replacement waits until SSE upstream cancellation completes", async () => {
  const gate = new Ingress();
  const canceled = Promise.withResolvers<void>();
  const response = gate.holdResponse(
    new Response(new ReadableStream({ cancel: () => canceled.promise })),
    gate.stream(),
  );
  let replaced = false;
  const replacement = gate.maintenance("replace", () => {
    replaced = true;
    return Promise.resolve();
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(replaced, false);
  canceled.resolve();
  await replacement;
  assert.equal(replaced, true);
  await assert.rejects(response.text(), /maintenance/);
});

Deno.test("drain waits for every SSE cancellation, not only the first one", async () => {
  const gate = new Ingress();
  const cancelA = Promise.withResolvers<void>();
  const cancelB = Promise.withResolvers<void>();
  const a = gate.holdResponse(
    new Response(new ReadableStream({ cancel: () => cancelA.promise })),
    gate.stream(),
  );
  const b = gate.holdResponse(
    new Response(new ReadableStream({ cancel: () => cancelB.promise })),
    gate.stream(),
  );
  let replaced = false;
  const work = gate.maintenance("replace", () => {
    replaced = true;
    return Promise.resolve();
  });
  cancelA.resolve();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(replaced, false);
  assert.equal(gate.status.streams, 1);
  cancelB.resolve();
  await work;
  await assert.rejects(a.text(), /maintenance/);
  await assert.rejects(b.text(), /maintenance/);
});
