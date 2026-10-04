import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { startServiceController } from "../container/service.ts";
import { AdmissionLedger } from "../src/admission.ts";
import { Controller } from "../src/controller.ts";
import { EngineGate } from "../src/engine.ts";
import { deadline, delay } from "../src/http.ts";
import { Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";

for (const resume of [false, true]) {
  for (const cause of ["SIGTERM", "Private Docker exited: 7"]) {
    Deno.test(`service ${resume ? "resume" : "new start"} cancellation during clock connect preserves ${cause}`, async () => {
      const base = await Deno.makeTempDir(), previous = Deno.env.get("PANDA_DATA_DIR");
      Deno.env.set("PANDA_DATA_DIR", base);
      const bake = await readBake("gloas", "panda");
      const start = Network.prototype.start,
        stop = Network.prototype.stop,
        fail = Network.prototype.fail;
      const fetch = globalThis.fetch;
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Response>();
      const abort = new AbortController(), events: string[] = [];
      let network: Network | undefined;
      Network.prototype.start = async function () {
        network = this;
        this.generation = await this.store.create(this.config, bake.key);
        if (resume) {
          this.generation.checkpoint = {
            abi: 1,
            nowMs: this.config.genesisTime * 1000 + 11_500,
            headSlot: 0,
            headBlockRoot: `0x${"ab".repeat(32)}`,
            headStateRoot: `0x${"cd".repeat(32)}`,
            forkChoiceSlot: 0,
            checkpointHash: `0x${"ef".repeat(32)}`,
          };
        }
        await AdmissionLedger.open(
          `${this.store.generationPath(this.generation.generation)}/admission.json`,
          { gethRevision: "unknown" },
        );
        return {
          config: this.config,
          bake,
          directory: this.directory,
          generation: this.generation.generation,
          el: "http://fixture/el",
          beacon: "http://fixture/bn",
          bnClock: "http://fixture/bnclock",
          vcClock: "http://fixture/vcclock",
          vc: "http://fixture/vc",
        };
      };
      Network.prototype.stop = async function () {
        events.push("destroy");
        if (this.generation) await this.store.destroy(this.generation);
      };
      Network.prototype.fail = async function (error) {
        events.push("fault");
        await this.setPhase("faulted", undefined, String(error));
      };
      globalThis.fetch = ((_url, init) => {
        entered.resolve();
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const cancel = () => {
            events.push("fetch-aborted");
            reject(signal?.reason);
          };
          if (signal?.aborted) cancel();
          else signal?.addEventListener("abort", cancel, { once: true });
          void release.promise.then(resolve).finally(() =>
            signal?.removeEventListener("abort", cancel)
          );
        });
      }) as typeof fetch;
      const startup = startServiceController(bake, abort.signal);
      void startup.catch(() => {});
      try {
        await deadline(entered.promise, 1000, "clock connection started");
        abort.abort(new Error(cause));
        await assert.rejects(deadline(startup, 200, "service cancellation"), new RegExp(cause));
        assert.deepEqual(events, ["fetch-aborted", resume ? "fault" : "destroy"]);
        assert.equal((await network!.store.active())?.phase, resume ? "faulted" : undefined);
      } finally {
        release.resolve(Response.json({ nowMs: 2_000_000_011_500, marks: {} }));
        await startup.then((controller) => controller.close(), () => {});
        globalThis.fetch = fetch;
        Network.prototype.start = start;
        Network.prototype.stop = stop;
        Network.prototype.fail = fail;
        if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
        else Deno.env.set("PANDA_DATA_DIR", previous);
        await Deno.remove(base, { recursive: true });
      }
    });
  }
}

Deno.test("already canceled service startup never enters Controller.start", async () => {
  const start = Controller.start;
  let calls = 0;
  Controller.start = () => {
    calls++;
    return Promise.reject(new Error("should not start"));
  };
  try {
    await assert.rejects(
      startServiceController(
        await readBake("gloas", "panda"),
        AbortSignal.abort(new Error("stop now")),
      ),
      /stop now/,
    );
    assert.equal(calls, 0);
  } finally {
    Controller.start = start;
  }
});

Deno.test("Engine startup aborts a pending Docker log subscription", async () => {
  const abort = new AbortController(),
    entered = Promise.withResolvers<void>(),
    released = Promise.withResolvers<PassThrough>();
  const stream = new PassThrough();
  let interrupted = false;
  const container = {
    logs: (options: { abortSignal?: AbortSignal }) => {
      entered.resolve();
      return new Promise((resolve, reject) => {
        const signal = options.abortSignal;
        const cancel = () => {
          interrupted = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
        void released.promise.then(resolve).finally(() =>
          signal?.removeEventListener("abort", cancel)
        );
      });
    },
  } as unknown as Parameters<typeof EngineGate.start>[1];
  const infra = { docker: { modem: { demuxStream() {} } } } as unknown as Parameters<
    typeof EngineGate.start
  >[0];
  const startup = EngineGate.start(
    infra,
    container,
    "http://fixture",
    0,
    "ab".repeat(32),
    abort.signal,
  );
  void startup.catch(() => {});
  try {
    await entered.promise;
    abort.abort(new Error("cancel Engine startup"));
    await assert.rejects(deadline(startup, 200, "Engine cancellation"), /cancel Engine startup/);
    assert.equal(interrupted, true);
  } finally {
    released.resolve(stream);
    await startup.then((gate) => gate.close(), () => {});
    stream.destroy();
  }
});

Deno.test("successful Engine log subscription outlives its startup signal and watchdog", async () => {
  const previous = Deno.env.get("PANDA_TIMEOUT_MS");
  Deno.env.set("PANDA_TIMEOUT_MS", "15");
  const abort = new AbortController(), stream = new PassThrough();
  const container = {
    logs: (options: { abortSignal?: AbortSignal }) => {
      options.abortSignal?.addEventListener("abort", () => stream.destroy(), { once: true });
      return Promise.resolve(stream);
    },
  } as unknown as Parameters<typeof EngineGate.start>[1];
  const infra = { docker: { modem: { demuxStream() {} } } } as unknown as Parameters<
    typeof EngineGate.start
  >[0];
  let gate: EngineGate | undefined;
  try {
    gate = await EngineGate.start(
      infra,
      container,
      "http://fixture",
      0,
      "ab".repeat(32),
      abort.signal,
    );
    abort.abort(new Error("SIGTERM after service ready"));
    await delay(35);
    assert.equal(stream.destroyed, false, "preserve must keep the Engine stream until gate.close");
  } finally {
    await gate?.close();
    stream.destroy();
    if (previous === undefined) Deno.env.delete("PANDA_TIMEOUT_MS");
    else Deno.env.set("PANDA_TIMEOUT_MS", previous);
  }
});
