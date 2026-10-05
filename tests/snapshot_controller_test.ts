/** Lifecycle/HTTP/storage adapter tests. Real EL/CL acceptance is a separate profile scenario. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { Devnet } from "../src/api.ts";
import { SnapshotJournal, SnapshotOperationError } from "../src/snapshot_operations.ts";
import { AdmissionLedger, pinnedGethRevision } from "../src/admission.ts";
import { configuration } from "../src/config.ts";
import { Consensus } from "../src/consensus.ts";
import { Controller } from "../src/controller.ts";
import { type Manifest, Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { type SnapshotRef, SnapshotStore } from "../src/snapshots.ts";
import { type Checkpoint, fileInventory, StateStore } from "../src/storage.ts";
import { Timeline } from "../src/time.ts";

Deno.test("saved snapshots can be downloaded through the controller without moving the chain", async () => {
  await fixture(async ({ controller, events }) => {
    await using net = new Devnet(controller.serve(0));
    const saved = await net.createSnapshot();
    const before = controller.lifecycle();
    const response = await fetch(`${net.url}/snapshots/${saved.id}/archive`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/gzip");
    assert.deepEqual([...bytes.slice(0, 2)], [0x1f, 0x8b]);
    const path = join(controller.network.store.root, "fixture.panda-snapshot.gz");
    const exported = await net.exportSnapshot(saved, path);
    assert.deepEqual(await Deno.readFile(path), bytes);
    assert.equal(exported.bytes, bytes.length);
    await assert.rejects(net.exportSnapshot(saved, path), /exist/i);
    assert.deepEqual(controller.lifecycle(), before);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
  });
});

async function fixture(
  run: (context: {
    controller: Controller;
    events: string[];
    hooks: {
      copy: () => Promise<void>;
      resume: () => Promise<void>;
      prepare: () => Promise<void>;
      candidate: () => Promise<void>;
      committed: () => Promise<void>;
      import: () => Promise<void>;
    };
  }) => Promise<void>,
) {
  const base = await Deno.makeTempDir({ prefix: "panda-snapshot-controller-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  const bake = await readBake("gloas", "p3-checkpoint-r5");
  const config = configuration({
    id: "snapshot-controller",
    profile: bake.profile,
    bake: bake.tag,
  });
  const network = new Network(config);
  const generation = await network.store.create(config, bake.key);
  network.generation = generation;
  const path = network.store.generationPath(generation.generation);
  for (const name of ["metadata", "jwt", "validator-keys"]) {
    await Deno.mkdir(join(path, "shared", name));
    await Deno.writeTextFile(join(path, "shared", name, "fixture"), name);
  }
  await Deno.mkdir(join(path, "shared", "validator-keys", "keys"));
  await Deno.writeTextFile(
    join(path, "shared", "validator-keys", "keys", "api-token.txt"),
    "fixture-token",
  );
  await Deno.writeTextFile(join(path, "el", "database"), "EL fixture");
  await Deno.writeTextFile(join(path, "bn", "database"), "BN fixture");
  const ledger = await AdmissionLedger.open(join(path, "admission.json"), {
    gethRevision: pinnedGethRevision,
  });
  generation.phase = "running";
  await network.store.write(generation);
  const hash = `0x${"12".repeat(32)}`;
  const time = () =>
    new Timeline(config.genesisTime * 1000, config.genesisTime * 1000 + 11_500, {
      move: () => Promise.reject(new Error("Capture must not move protocol time")),
    });
  const receipt: Checkpoint = {
    abi: 1,
    nowMs: time().nowMs,
    headSlot: 0,
    headBlockRoot: hash,
    headStateRoot: hash,
    forkChoiceSlot: 1,
    checkpointHash: hash,
    executionHash: hash,
  };
  const events: string[] = [];
  const hooks = {
    copy: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    prepare: () => Promise.resolve(),
    candidate: () => Promise.resolve(),
    committed: () => Promise.resolve(),
    import: () => Promise.resolve(),
  };
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const endpoint = new URL(request.url).pathname;
      if (endpoint === "/park") {
        return Response.json({ parked: true, activeWork: 0, nowMs: receipt.nowMs });
      }
      if (endpoint === "/resume") return Response.json({});
      if (endpoint === "/eth/v1/keystores") {
        await hooks.import();
        return Response.json({ data: [{ status: "imported" }] });
      }
      if (endpoint === "/lighthouse/panda/checkpoint") return Response.json(receipt);
      if (endpoint === "/eth/v1/beacon/headers/head") {
        return Response.json({
          data: { root: hash, header: { message: { slot: "0", state_root: hash } } },
        });
      }
      if (request.method === "GET") return Response.json({ marks: { ready: 0, indices: 0 } });
      const call = await request.json();
      const result = call.method === "eth_getBlockByNumber"
        ? { hash, gasLimit: "0x100000", gasUsed: "0x80000", baseFeePerGas: "0x1" }
        : call.method === "txpool_status"
        ? { pending: "0x0", queued: "0x0" }
        : call.method === "txpool_content"
        ? { pending: {}, queued: {} }
        : null;
      return Response.json({ jsonrpc: "2.0", id: call.id, result });
    },
  );
  const url = `http://127.0.0.1:${upstream.addr.port}`;
  const manifest: Manifest = {
    config,
    bake,
    generation: generation.generation,
    directory: join(path, "shared"),
    el: url,
    beacon: url,
    vc: url,
    bnClock: url,
    vcClock: url,
  };
  const originals = {
    start: Network.prototype.start,
    startCandidate: Network.prototype.startCandidate,
    commitCandidate: Network.prototype.commitCandidate,
    fail: Network.prototype.fail,
    discard: Network.prototype.discard,
    preserve: Network.prototype.preserve,
    stop: Network.prototype.stop,
    connect: Consensus.connect,
    capture: SnapshotStore.prototype.capture,
    prepare: SnapshotStore.prototype.prepare,
  };
  network.infra.docker.listContainers =
    (() => Promise.resolve([])) as typeof network.infra.docker.listContainers;
  Network.prototype.preserve = async function (checkpoint) {
    events.push("stop");
    const path = this.store.generationPath(this.generation!.generation);
    const shared: Record<string, unknown> = {};
    for (const name of ["metadata", "jwt", "validator-keys"]) {
      shared[name] = await fileInventory(join(path, "shared", name));
    }
    await this.setPhase("stopped", {
      ...checkpoint,
      sharedFiles: shared,
      databaseFiles: {
        el: await fileInventory(join(path, "el")),
        bn: await fileInventory(join(path, "bn")),
      },
    });
  };
  Network.prototype.start = async function () {
    events.push("resume");
    await hooks.resume();
    this.generation = await this.store.resumable();
    this.infra.docker.listContainers =
      (() => Promise.resolve([])) as typeof this.infra.docker.listContainers;
    return {
      ...structuredClone(manifest),
      generation: this.generation.generation,
      directory: this.directory,
    };
  };
  Network.prototype.startCandidate = async function (candidate) {
    events.push("candidate-start");
    await hooks.candidate();
    this.generation = { ...candidate, phase: "starting" };
    this.infra.docker.listContainers =
      (() => Promise.resolve([])) as typeof this.infra.docker.listContainers;
    return {
      ...structuredClone(manifest),
      generation: candidate.generation,
      directory: this.directory,
    };
  };
  Network.prototype.commitCandidate = async function () {
    events.push("candidate-commit");
    await this.store.write(this.generation!);
    await hooks.committed();
  };
  Network.prototype.fail = async function (error) {
    events.push("discard");
    if (this.generation && (await this.store.active())?.generation === this.generation.generation) {
      await this.setPhase("faulted", undefined, String(error));
    }
  };
  Network.prototype.discard = async function () {
    await this.fail(new Error("Branch discarded"));
    try {
      this.releaseRecovery();
    } catch { /* Live adapter sessions own no real network lock. */ }
  };
  Network.prototype.stop = async function () {
    events.push("destroy");
    const active = await this.store.active();
    if (active) await this.store.destroy(active);
  };
  Consensus.connect = () => Promise.resolve(time());
  SnapshotStore.prototype.capture = async function (...args) {
    events.push("capture");
    await hooks.copy();
    return await originals.capture.apply(this, args);
  };
  SnapshotStore.prototype.prepare = async function (...args) {
    events.push("prepare");
    await hooks.prepare();
    return await originals.prepare.apply(this, args);
  };
  const controller = new Controller(network, manifest, time(), ledger);
  try {
    await run({ controller, events, hooks });
  } finally {
    await controller.close();
    Object.assign(Network.prototype, {
      start: originals.start,
      startCandidate: originals.startCandidate,
      commitCandidate: originals.commitCandidate,
      fail: originals.fail,
      discard: originals.discard,
      preserve: originals.preserve,
      stop: originals.stop,
    });
    Consensus.connect = originals.connect;
    SnapshotStore.prototype.capture = originals.capture;
    SnapshotStore.prototype.prepare = originals.prepare;
    await upstream.shutdown();
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("create snapshot checkpoints once, resumes the same time and restores automine", async () => {
  await fixture(async ({ controller, events }) => {
    await controller.automine.set(true);
    const before = controller.lifecycle();
    const id = crypto.randomUUID();
    const saved = await controller.command("snapshotCreate", [id]) as SnapshotRef;
    assert.equal(saved.id, id);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
    assert.equal(controller.lifecycle().ready, true);
    assert.equal(controller.time.nowMs, before.now! * 1000);
    assert.notEqual(controller.lifecycle().sessionId, before.sessionId);
    assert.equal(controller.automine.enabled, true);
    await controller.automine.set(false);
    assert.equal(controller.automine.error, undefined);
    assert.deepEqual(await controller.command("snapshotList"), [saved]);
    const operation = await controller.command("snapshotOperation", [id]) as {
      state: string;
      result: SnapshotRef;
    };
    assert.equal(operation.state, "succeeded");
    assert.deepEqual(operation.result, saved);
    // Recover a lost response using the same request ID, without stopping/signing again.
    const session = controller.lifecycle().sessionId;
    assert.deepEqual(await controller.command("snapshotCreate", [id]), saved);
    assert.equal(controller.lifecycle().sessionId, session);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
  });
});

Deno.test("restore is reusable, changes session/generation and leaves automine off at the saved time", async () => {
  await fixture(async ({ controller, events }) => {
    const url = controller.serve(0);
    const saved = await controller.createSnapshot(crypto.randomUUID());
    const source = controller.lifecycle();
    const abandoned = join(
      controller.network.store.generationPath(source.generation!),
      "el",
      "database",
    );
    await Deno.writeTextFile(abandoned, "discarded future");
    controller.time.nowMs += 12_000;
    await controller.command("setAutomine", [true]);
    const id = crypto.randomUUID();
    const result = await controller.command("snapshotRestore", [saved.id, id]);
    const restored = controller.lifecycle();
    assert.notEqual(restored.sessionId, source.sessionId);
    assert.notEqual(restored.generation, source.generation);
    assert.equal(restored.now! * 1000, saved.nowMs);
    assert.equal(restored.ready, true);
    assert.equal(controller.automine.enabled, false);
    assert.equal((await new Devnet(url).lifecycle()).sessionId, restored.sessionId);
    const file = () =>
      join(
        controller.network.store.generationPath(controller.manifest.generation!),
        "el",
        "database",
      );
    assert.equal(await Deno.readTextFile(file()), "EL fixture");
    await assert.rejects(Deno.stat(abandoned), Deno.errors.NotFound);
    assert.deepEqual(await controller.command("snapshotRestore", [saved.id, id]), result);
    assert.equal(controller.lifecycle().sessionId, restored.sessionId);
    await assert.rejects(controller.command("snapshotCreate", [id]), /different request/);
    await Deno.writeTextFile(file(), "second discarded future");
    await controller.command("snapshotRestore", [saved.id, crypto.randomUUID()]);
    assert.equal(await Deno.readTextFile(file()), "EL fixture");
    assert.notEqual(controller.lifecycle().generation, restored.generation);
    assert.deepEqual(await controller.command("snapshotList"), [saved]);
    assert.deepEqual(events, [
      "stop",
      "capture",
      "resume",
      "prepare",
      "discard",
      "candidate-start",
      "candidate-commit",
      "prepare",
      "discard",
      "candidate-start",
      "candidate-commit",
    ]);
  });
});

Deno.test("SDK starts from a retained snapshot after owning close removed the runtime", async () => {
  await fixture(async ({ controller, events }) => {
    const snapshot = await controller.createSnapshot(crypto.randomUUID());
    const owner = controller.manifest.config.id;
    await controller.close();
    assert.equal(await controller.network.store.active(), undefined);
    const operationId = crypto.randomUUID();
    await using api = await Devnet.fromSnapshot(snapshot, { id: owner, operationId });
    assert.equal((await api.lifecycle()).ready, true);
    assert.equal((await api.lifecycle()).recoveryRequired, false);
    assert.equal((await api.status()).now * 1000, snapshot.nowMs);
    assert.deepEqual(await api.listSnapshots(), [snapshot]);
    await api.close();
    assert.equal(await controller.network.store.active(), undefined);
    const calls = events.length;
    await assert.rejects(
      Devnet.fromSnapshot(snapshot, { id: owner, operationId }),
      /earlier session/,
    );
    assert.equal(events.length, calls, "replaying a completed operation started another candidate");
    const snapshots = new SnapshotStore(controller.network.store, controller.network.infra);
    assert.deepEqual(await snapshots.list(), [snapshot]);
  });
});

Deno.test("SDK removes an archive with durable replay while its restored network keeps running", async () => {
  await fixture(async ({ controller, events }) => {
    await using api = new Devnet(controller.serve(0));
    const saved = await api.createSnapshot();
    await api.restoreSnapshot(saved);
    const before = await api.lifecycle();
    const calls = events.length;
    const operationId = crypto.randomUUID();
    assert.deepEqual(await api.removeSnapshot(saved, { operationId }), saved);
    assert.deepEqual(await api.listSnapshots(), []);
    assert.deepEqual(await api.removeSnapshot(saved, { operationId }), saved);
    assert.equal((await api.snapshotOperation(operationId))?.state, "succeeded");
    assert.deepEqual(await api.lifecycle(), before);
    assert.equal(events.length, calls);
    await assert.rejects(api.restoreSnapshot(saved), /removed/);
    assert.equal((await api.lifecycle()).ready, true);
    await assert.rejects(api.createSnapshot({ operationId }), /different request/);
  });
});

Deno.test("archive removal is refused throughout restore preparation and startup", async () => {
  await fixture(async ({ controller, hooks }) => {
    const saved = await controller.createSnapshot(crypto.randomUUID());
    for (const stage of ["prepare", "candidate"] as const) {
      hooks[stage] = async () => {
        await assert.rejects(
          controller.removeSnapshot(saved.id, crypto.randomUUID()),
          /in progress/,
        );
        const snapshots = new SnapshotStore(controller.network.store, controller.network.infra);
        const journal = new SnapshotJournal(controller.network.store);
        await assert.rejects(
          journal.remove(snapshots, saved.id, crypto.randomUUID()),
          /owned by live process/,
        );
        await snapshots.read(saved.id);
      };
    }
    await controller.restoreSnapshot(saved.id, crypto.randomUUID());
    assert.equal(controller.lifecycle().ready, true);
  });
});

Deno.test("failed start-from-snapshot keeps the artifact and releases offline ownership for retry", async () => {
  await fixture(async ({ controller, hooks }) => {
    const snapshot = await controller.createSnapshot(crypto.randomUUID());
    const owner = controller.manifest.config.id;
    await controller.close();
    hooks.candidate = () => Promise.reject(new Error("offline candidate failed"));
    await assert.rejects(Devnet.fromSnapshot(snapshot, { id: owner }), /offline candidate failed/);
    assert.equal(await controller.network.store.active(), undefined);
    hooks.candidate = () => Promise.resolve();
    await using api = await Devnet.fromSnapshot(snapshot, { id: owner });
    assert.equal((await api.lifecycle()).ready, true);
  });
});

Deno.test("restore accepts a faulted Timeline without trying to checkpoint the discarded branch", async () => {
  await fixture(async ({ controller, events }) => {
    const saved = await controller.createSnapshot(crypto.randomUUID());
    await assert.rejects(controller.command("stepSlot"), /must not move/);
    assert.equal(controller.lifecycle().ready, false);
    await controller.command("snapshotRestore", [saved.id, crypto.randomUUID()]);
    assert.equal(controller.lifecycle().ready, true);
    assert.equal(controller.time.nowMs, saved.nowMs);
    assert.equal(events.filter((event) => event === "stop").length, 1);
  });
});

Deno.test("restore persists discard intent before cancelling the old Timeline", async () => {
  await fixture(async ({ controller }) => {
    const saved = await controller.createSnapshot(crypto.randomUUID());
    const id = crypto.randomUUID();
    let recordedStage: string | undefined;
    controller.time.backend.cancel = () => {
      recordedStage = JSON.parse(
        Deno.readTextFileSync(join(controller.network.store.root, "operations", `${id}.json`)),
      ).stage;
    };
    await controller.restoreSnapshot(saved.id, id);
    assert.equal(recordedStage, "source-stopping");
  });
});

Deno.test("corrupt restore input is refused while the source remains available", async () => {
  await fixture(async ({ controller, events }) => {
    const saved = await controller.createSnapshot(crypto.randomUUID());
    const before = controller.lifecycle();
    const root = await controller.network.store.snapshotsDirectory();
    await Deno.writeTextFile(join(root, saved.id, "data", "el", "database"), "damaged");
    await assert.rejects(
      controller.command("snapshotRestore", [saved.id, crypto.randomUUID()]),
      /integrity/,
    );
    assert.equal(controller.lifecycle().ready, true);
    assert.equal(controller.lifecycle().sessionId, before.sessionId);
    assert.equal(events.includes("discard"), false);
  });
});

Deno.test("failed candidate leaves the old pointer faulted and requires an explicit new restore request", async () => {
  await fixture(async ({ controller, hooks, events }) => {
    const saved = await controller.createSnapshot(crypto.randomUUID());
    const source = controller.lifecycle().generation;
    hooks.candidate = () => Promise.reject(new Error("candidate startup failed"));
    const id = crypto.randomUUID();
    await assert.rejects(
      controller.command("snapshotRestore", [saved.id, id]),
      /candidate startup failed/,
    );
    assert.equal(controller.lifecycle().ready, false);
    assert.equal((await controller.network.store.active())!.generation, source);
    assert.equal((await controller.network.store.active())!.phase, "faulted");
    const count = events.length;
    await assert.rejects(
      controller.command("snapshotRestore", [saved.id, id]),
      /candidate startup failed/,
    );
    assert.equal(events.length, count);
    hooks.candidate = () => Promise.resolve();
    await controller.command("snapshotRestore", [saved.id, crypto.randomUUID()]);
    assert.equal(controller.lifecycle().ready, true);
  });
});

Deno.test("post-commit failure keeps the candidate authoritative, including during the next explicit restore", async () => {
  await fixture(async ({ controller, hooks }) => {
    const saved = await controller.createSnapshot(crypto.randomUUID());
    const source = controller.lifecycle().generation;
    hooks.committed = () => Promise.reject(new Error("lost commit acknowledgement"));
    await assert.rejects(
      controller.restoreSnapshot(saved.id, crypto.randomUUID()),
      /lost commit acknowledgement/,
    );
    const published = await controller.network.store.active();
    assert.notEqual(published!.generation, source);
    assert.equal(published!.generation, controller.lifecycle().generation);
    assert.equal(published!.phase, "faulted");
    assert.equal(controller.lifecycle().ready, false);
    hooks.committed = () => Promise.resolve();
    const operation = crypto.randomUUID();
    await controller.restoreSnapshot(saved.id, operation);
    const journal = await controller.command("snapshotOperation", [operation]) as {
      sourceGeneration: string;
    };
    assert.equal(journal.sourceGeneration, published!.generation);
    assert.notEqual(controller.lifecycle().generation, source);
    assert.notEqual(controller.lifecycle().generation, published!.generation);
  });
});

Deno.test("restore preparation preserves availability, deduplicates exact requests and delays shutdown", async () => {
  await fixture(async ({ controller, hooks, events }) => {
    const saved = await controller.createSnapshot(crypto.randomUUID());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hooks.prepare = () => {
      entered.resolve();
      return release.promise;
    };
    const id = crypto.randomUUID();
    const work = controller.restoreSnapshot(saved.id, id);
    const duplicate = controller.restoreSnapshot(saved.id, id);
    assert.equal(work, duplicate);
    try {
      await entered.promise;
      assert.equal(controller.lifecycle().ready, true);
      await assert.rejects(
        controller.restoreSnapshot(crypto.randomUUID(), id),
        /different request/,
      );
      await assert.rejects(
        controller.restoreSnapshot(saved.id, crypto.randomUUID()),
        /Another lifecycle/,
      );
      const closing = controller.close();
      await Promise.resolve();
      assert.equal(events.includes("destroy"), false);
      release.resolve();
      await work;
      await closing;
      assert.equal(events.filter((event) => event === "candidate-start").length, 1);
      assert.equal(events.at(-1), "destroy");
    } finally {
      release.resolve();
      await work.catch(() => {});
    }
  });
});

Deno.test("shutdown prevents snapshot work from starting after an earlier journal read yields", async (t) => {
  for (const shutdown of ["destructive", "preserving"] as const) {
    for (const action of ["create", "restore", "remove"] as const) {
      await t.step(`${shutdown} ${action}`, () =>
        fixture(async ({ controller, events }) => {
          const snapshot = await controller.createSnapshot(crypto.randomUUID());
          const id = crypto.randomUUID();
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const read = SnapshotJournal.prototype.read;
          let held = false;
          SnapshotJournal.prototype.read = async function (request) {
            if (request === id && !held) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return await read.call(this, request);
          };
          const work = (action === "create"
            ? controller.createSnapshot(id)
            : action === "restore"
            ? controller.restoreSnapshot(snapshot.id, id)
            : controller.removeSnapshot(snapshot.id, id)).then(
              () => undefined,
              (error: unknown) => error,
            );
          try {
            await entered.promise;
            if (shutdown === "preserving") await controller.closePreserving();
            else await controller.close();
            const calls = events.length;
            release.resolve();
            assert.match(String(await work), /stopping/);
            assert.equal(events.length, calls, "snapshot work ran after shutdown completed");
            assert.equal(
              await read.call(new SnapshotJournal(controller.network.store), id),
              undefined,
            );
            if (shutdown === "destructive") {
              assert.equal(await controller.network.store.active(), undefined);
            } else assert.equal((await controller.network.store.active())!.phase, "stopped");
          } finally {
            release.resolve();
            await work;
            SnapshotJournal.prototype.read = read;
          }
        }));
    }
  }
});

Deno.test("restore cancels an accepted hung keymanager request before replacing the session", async () => {
  await fixture(async ({ controller, hooks }) => {
    const saved = await controller.createSnapshot(crypto.randomUUID());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hooks.import = () => {
      entered.resolve();
      return release.promise;
    };
    const importWork = controller.command("importValidator", [
      JSON.stringify({ version: 4, pubkey: "12".repeat(48) }),
      "password",
    ]);
    const cancelled = assert.rejects(importWork, /discarded/);
    try {
      await entered.promise;
      await controller.restoreSnapshot(saved.id, crypto.randomUUID());
      await cancelled;
      assert.equal(controller.lifecycle().ready, true);
      assert.equal(controller.time.nowMs, saved.nowMs);
    } finally {
      release.resolve();
      await cancelled;
    }
  });
});

Deno.test("SDK reconciles a lost restore response and never restores the same operation twice", async () => {
  await fixture(async ({ controller, events }) => {
    const api = new Devnet(controller.serve(0));
    const snapshot = await api.createSnapshot();
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (init?.body && JSON.parse(String(init.body)).method === "snapshotRestore") {
        await response.arrayBuffer();
        throw new Error("lost restore response");
      }
      return response;
    };
    try {
      const result = await api.restoreSnapshot(snapshot);
      assert.equal(result.generation, controller.lifecycle().generation);
      assert.equal(result.sessionId, controller.lifecycle().sessionId);
      assert.equal(events.filter((event) => event === "candidate-start").length, 1);
    } finally {
      globalThis.fetch = fetch;
      await api.close();
    }
  });
});

Deno.test("concurrent identical snapshot requests share work and later mutations are refused", async () => {
  await fixture(async ({ controller, events, hooks }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hooks.copy = async () => {
      entered.resolve();
      await release.promise;
    };
    const id = crypto.randomUUID();
    const first = controller.command("snapshotCreate", [id]);
    // Attach rejection handling before waiting for the controlled copy boundary.
    const arrived = Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("Capture skipped copy");
      }),
    ]);
    await arrived;
    const second = controller.command("snapshotCreate", [id]);
    try {
      await assert.rejects(controller.command("stepSlot"), /maintenance/);
      await assert.rejects(
        controller.command("snapshotCreate", [crypto.randomUUID()]),
        /in progress/,
      );
      assert.equal(controller.lifecycle().ready, false);
    } finally {
      release.resolve();
    }
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
  });
});

Deno.test("failed copy leaves no snapshot and resumes the verified source", async () => {
  await fixture(async ({ controller, events, hooks }) => {
    hooks.copy = () => Promise.reject(new Error("injected copy failure"));
    const before = controller.time.nowMs;
    const id = crypto.randomUUID();
    await assert.rejects(controller.command("snapshotCreate", [id]), /injected copy failure/);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
    assert.equal(controller.lifecycle().ready, true);
    assert.equal(controller.time.nowMs, before);
    assert.deepEqual(await controller.command("snapshotList"), []);
    await assert.rejects(controller.command("snapshotCreate", [id]), /injected copy failure/);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
  });
});

Deno.test("failed capture removes its partial copy without changing the active source", async () => {
  await fixture(async ({ controller }) => {
    const store = controller.network.store;
    const source = controller.lifecycle().generation!;
    const copy = Deno.copyFile;
    let injected = false;
    Deno.copyFile = async (from, to) => {
      await copy(from, to);
      injected = true;
      throw new Error("partial snapshot copy failed");
    };
    try {
      await assert.rejects(controller.createSnapshot(crypto.randomUUID()), /partial snapshot copy/);
    } finally {
      Deno.copyFile = copy;
    }
    assert(injected);
    assert.equal(controller.lifecycle().ready, true);
    const generations = [];
    for await (const entry of Deno.readDir(join(store.root, "generations"))) {
      generations.push(entry.name);
    }
    assert.deepEqual(generations, [source], "partial capture generation leaked");
  });
});

Deno.test("repeated restore removes discarded generations and preserves the reusable archive", async () => {
  await fixture(async ({ controller }) => {
    const snapshot = await controller.createSnapshot(crypto.randomUUID());
    const store = controller.network.store;
    for (let i = 0; i < 2; i++) {
      const result = await controller.restoreSnapshot(snapshot.id, crypto.randomUUID());
      const generations = [];
      for await (const entry of Deno.readDir(join(store.root, "generations"))) {
        generations.push(entry.name);
      }
      assert.deepEqual(generations, [result.generation], "discarded branch leaked");
      assert.equal(controller.lifecycle().ready, true);
      await new SnapshotStore(store, controller.network.infra).read(snapshot.id);
    }
  });
});

Deno.test("cleanup failure keeps the restored chain authoritative and a later restore finishes deletion", async () => {
  await fixture(async ({ controller }) => {
    const snapshot = await controller.createSnapshot(crypto.randomUUID());
    const store = controller.network.store;
    const source = controller.lifecycle().generation!;
    const trash = join(store.root, "generations", `.discarded-${source}`);
    const remove = Deno.remove;
    let injected = false;
    Deno.remove = async (path, options) => {
      if (String(path) === trash) {
        injected = true;
        // Simulate interruption after recursive unlink has already removed the ownership marker.
        await remove(join(trash, "owner.json"));
        throw new Error("injected partial cleanup failure");
      }
      await remove(path, options);
    };
    const operation = crypto.randomUUID();
    let result: Awaited<ReturnType<Controller["restoreSnapshot"]>>;
    try {
      result = await controller.restoreSnapshot(snapshot.id, operation);
    } finally {
      Deno.remove = remove;
    }
    assert(injected);
    assert.equal(controller.lifecycle().ready, true);
    assert.equal(controller.lifecycle().generation, result.generation);
    assert.equal(controller.lifecycle().cleanup?.state, "failed");
    const record = (await new SnapshotJournal(store).read(operation))!;
    assert.equal(record.state, "succeeded");
    assert.equal(record.cleanup?.state, "failed");
    assert.match(record.cleanup!.error!, /partial cleanup failure/);
    assert.deepEqual(record.result, result);
    assert.deepEqual(await controller.restoreSnapshot(snapshot.id, operation), result);
    await Deno.stat(trash);
    const next = await controller.restoreSnapshot(snapshot.id, crypto.randomUUID());
    assert.equal(controller.lifecycle().cleanup?.state, "succeeded");
    const generations = [];
    for await (const entry of Deno.readDir(join(store.root, "generations"))) {
      generations.push(entry.name);
    }
    assert.deepEqual(generations, [next.generation]);
    await new SnapshotStore(store, controller.network.infra).read(snapshot.id);
  });
});

Deno.test("cleanup retains the old branch while active pointer durability cannot be confirmed", async () => {
  await fixture(async ({ controller }) => {
    const snapshot = await controller.createSnapshot(crypto.randomUUID());
    const store = controller.network.store;
    const source = controller.lifecycle().generation!;
    const original = store.generationPath(source);
    const open = Deno.open;
    const rename = Deno.rename;
    let uncertain = false;
    Deno.rename = async (from, to) => {
      await rename(from, to);
      if (String(to) === join(store.root, "active.json")) {
        uncertain ||= (await store.active())!.generation !== source;
      }
    };
    Deno.open = async (path, options) => {
      const file = await open(path, options);
      if (uncertain && String(path) === store.root) {
        file.sync = () => Promise.reject(new Error("injected active pointer sync failure"));
      }
      return file;
    };
    try {
      await assert.rejects(
        controller.restoreSnapshot(snapshot.id, crypto.randomUUID()),
        /sync failure/,
      );
      assert(uncertain);
      assert.notEqual((await store.active())!.generation, source);
      await Deno.stat(original);
    } finally {
      Deno.open = open;
      Deno.rename = rename;
    }
    await controller.restoreSnapshot(snapshot.id, crypto.randomUUID());
    await assert.rejects(Deno.stat(original), Deno.errors.NotFound);
  });
});

Deno.test("allocation is journaled before mkdir and a partial allocation can be cleaned", async () => {
  await fixture(async ({ controller }) => {
    const store = controller.network.store;
    const source = controller.lifecycle().generation!;
    const operation = crypto.randomUUID();
    const mkdir = Deno.mkdir;
    let injected = false;
    Deno.mkdir = async (path, options) => {
      await mkdir(path, options);
      if (String(path).startsWith(join(store.root, "generations") + "/") && !injected) {
        const record = (await new SnapshotJournal(store).read(operation))!;
        assert.equal(store.generationPath(record.candidateGeneration!), String(path));
        injected = true;
        throw new Error("injected incomplete allocation");
      }
    };
    try {
      await assert.rejects(controller.createSnapshot(operation), /incomplete allocation/);
    } finally {
      Deno.mkdir = mkdir;
    }
    assert(injected);
    assert.equal(controller.lifecycle().ready, true);
    const generations = [];
    for await (const entry of Deno.readDir(join(store.root, "generations"))) {
      generations.push(entry.name);
    }
    assert.deepEqual(generations, [source]);
  });
});

Deno.test("cleanup preserves unrecorded generations and another owner's files", async () => {
  await fixture(async ({ controller }) => {
    const snapshot = await controller.createSnapshot(crypto.randomUUID());
    const store = controller.network.store;
    const unrelated = await store.allocate(controller.network.config, controller.manifest.bake.key);
    const path = store.generationPath(unrelated.generation);
    const files = await fileInventory(path);
    const other = new StateStore("unrelated-snapshot-owner");
    await other.initialize();
    const sentinel = join(other.root, "keep.txt");
    await Deno.writeTextFile(sentinel, "unrelated data");
    await controller.restoreSnapshot(snapshot.id, crypto.randomUUID());
    assert.deepEqual(await fileInventory(path), files);
    assert.equal(await Deno.readTextFile(sentinel), "unrelated data");
  });
});

Deno.test("published snapshot remains queryable when source restart fails", async () => {
  await fixture(async ({ controller, events, hooks }) => {
    hooks.resume = () => Promise.reject(new Error("injected restart failure"));
    const id = crypto.randomUUID();
    await assert.rejects(controller.command("snapshotCreate", [id]), /restart failure/);
    const operation = await controller.command("snapshotOperation", [id]) as {
      state: string;
      snapshot?: SnapshotRef;
    };
    assert.equal(operation.state, "failed");
    assert.equal(operation.snapshot?.id, id);
    const saved = await controller.command("snapshotList") as SnapshotRef[];
    assert.equal(saved[0].id, id);
    assert.equal(controller.lifecycle().ready, false);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
    await assert.rejects(controller.command("snapshotCreate", [id]), /restart failure/);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
  });
});

Deno.test("creation persistence failures preserve the source and report actual publication", async (t) => {
  for (
    const fault of [
      "manifest write",
      "manifest sync",
      "manifest rename",
      "manifest directory sync",
      "publication rename",
      "publication acknowledgement",
      "publication directory sync",
    ]
  ) {
    await t.step(fault, async () => {
      await fixture(async ({ controller, events }) => {
        const id = crypto.randomUUID();
        const parent = await controller.network.store.snapshotsDirectory();
        const pending = join(parent, `.pending-${id}`);
        const final = join(parent, id);
        const before = controller.lifecycle();
        const open = Deno.open;
        const rename = Deno.rename;
        let published = false;
        let injected = false;
        const fail = () => {
          injected = true;
          throw new Error(`injected ${fault}`);
        };
        Deno.open = async (path, options) => {
          const file = await open(path, options);
          if (!injected && String(path).startsWith(join(pending, "manifest.json."))) {
            if (fault === "manifest write") file.write = () => Promise.reject(fail());
            if (fault === "manifest sync") file.sync = () => Promise.reject(fail());
          }
          if (
            !injected &&
            (fault === "manifest directory sync" && String(path) === pending ||
              fault === "publication directory sync" && published && String(path) === parent)
          ) file.sync = () => Promise.reject(fail());
          return file;
        };
        Deno.rename = async (from, to) => {
          if (
            !injected && fault === "manifest rename" &&
            String(to) === join(pending, "manifest.json")
          ) {
            fail();
          }
          if (String(from) === pending && String(to) === final) {
            if (!injected && fault === "publication rename") fail();
            await rename(from, to);
            published = true;
            if (!injected && fault === "publication acknowledgement") fail();
          } else await rename(from, to);
        };
        try {
          await assert.rejects(controller.createSnapshot(id), (error: unknown) => {
            assert(error instanceof SnapshotOperationError);
            assert.match(error.message, new RegExp(`injected ${fault}`));
            assert.equal(error.operation.state, "failed");
            assert.equal(error.operation.snapshot?.id, published ? id : undefined);
            return true;
          });
        } finally {
          Deno.open = open;
          Deno.rename = rename;
        }
        assert(injected, `failure injection was not reached: ${fault}`);
        assert.equal(controller.lifecycle().ready, true);
        assert.equal(controller.lifecycle().generation, before.generation);
        assert.equal(controller.lifecycle().now, before.now);
        const snapshots = new SnapshotStore(controller.network.store, controller.network.infra);
        assert.deepEqual((await snapshots.list()).map((item) => item.id), published ? [id] : []);
        await assert.rejects(Deno.stat(pending), Deno.errors.NotFound);
        if (published) await snapshots.read(id);
        const count = events.length;
        await assert.rejects(controller.createSnapshot(id), /injected/);
        assert.equal(events.length, count, "retry repeated a failed mutation");
      });
    });
  }
});

Deno.test("recovery reconciles interrupted creation without starting a source or repeating capture", async (t) => {
  for (const published of [false, true]) {
    await t.step(published ? "published" : "not published", async () => {
      await fixture(async ({ controller, events, hooks }) => {
        const id = crypto.randomUUID();
        const journal = new SnapshotJournal(controller.network.store);
        if (published) await controller.createSnapshot(id);
        else {
          hooks.copy = () => Promise.reject(new Error("interrupted before publication"));
          await assert.rejects(controller.createSnapshot(id), /interrupted/);
        }
        // Reproduce the durable record left by process loss before the outcome could be written.
        const record = (await journal.read(id))!;
        await journal.update(record, {
          state: "running",
          stage: "copying",
          snapshot: undefined,
          result: undefined,
          error: undefined,
        });
        await controller.closePreserving();
        const active = await controller.network.store.active();
        const recovery = await Controller.recover(controller.network.config.id);
        const count = events.length;
        try {
          await assert.rejects(recovery.createSnapshot(id), (error: unknown) => {
            assert(error instanceof SnapshotOperationError);
            assert.match(error.message, /creation was interrupted/);
            assert.equal(error.operation.stage, "copying");
            assert.equal(error.operation.state, "failed");
            assert.equal(error.operation.snapshot?.id, published ? id : undefined);
            return true;
          });
          assert.equal(events.length, count, "reconciliation started clients or repeated capture");
          assert.equal(recovery.lifecycle().ready, false);
          assert.equal(recovery.lifecycle().recoveryRequired, true);
          assert.deepEqual(await controller.network.store.active(), active);
          assert.equal((await journal.read(id))?.state, "failed");
          await assert.rejects(recovery.createSnapshot(id), /creation was interrupted/);
          const fresh = crypto.randomUUID();
          await assert.rejects(recovery.createSnapshot(fresh), /recovery/);
          assert.equal(await journal.read(fresh), undefined);
        } finally {
          await recovery.closePreserving();
        }
      });
    });
  }
});

Deno.test("preserving shutdown during failed capture keeps the already clean source stopped", async () => {
  await fixture(async ({ controller, events, hooks }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hooks.copy = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("copy failed during shutdown");
    };
    const saving = assert.rejects(
      controller.command("snapshotCreate", [crypto.randomUUID()]),
      /copy failed/,
    );
    await entered.promise;
    const closing = assert.rejects(controller.closePreserving(), /copy failed/);
    release.resolve();
    await Promise.all([saving, closing]);
    assert.deepEqual(events, ["stop", "capture"]);
    assert.equal((await controller.network.store.active())?.phase, "stopped");
    assert.equal(controller.lifecycle().ready, false);
  });
});

Deno.test("SDK recovers a lost create response from the durable operation without repeating it", async () => {
  await fixture(async ({ controller, events }) => {
    await using net = new Devnet(controller.serve(0));
    const id = crypto.randomUUID();
    const originalFetch = globalThis.fetch;
    let dropped = false;
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (
        !dropped && typeof init?.body === "string" &&
        JSON.parse(init.body).method === "snapshotCreate"
      ) {
        assert.equal(response.status, 200);
        await response.text();
        dropped = true;
        throw new TypeError("injected response loss");
      }
      return response;
    };
    let saved: SnapshotRef;
    try {
      saved = await net.createSnapshot({ operationId: id });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(dropped, true);
    assert.equal(saved.id, id);
    assert.deepEqual(await net.listSnapshots(), [saved]);
    assert.equal((await net.snapshotOperation(id))?.state, "succeeded");
    assert.deepEqual(await net.createSnapshot({ operationId: id }), saved);
    assert.deepEqual(events, ["stop", "capture", "resume"]);
    assert.equal(controller.lifecycle().ready, true);
  });
});

Deno.test("SDK exposes the retained snapshot in a structured partial-failure error", async () => {
  await fixture(async ({ controller, hooks }) => {
    hooks.resume = () => Promise.reject(new Error("cannot resume source"));
    await using net = new Devnet(controller.serve(0));
    const id = crypto.randomUUID();
    await assert.rejects(net.createSnapshot({ operationId: id }), (error) => {
      assert(error instanceof SnapshotOperationError);
      assert.equal(error.operation.id, id);
      assert.equal(error.operation.state, "failed");
      assert.equal(error.operation.snapshot?.id, id);
      return true;
    });
    assert.equal((await net.listSnapshots())[0].id, id);
    assert.equal((await net.lifecycle()).ready, false);
  });
});
