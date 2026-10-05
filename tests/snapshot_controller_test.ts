import assert from "node:assert/strict";
import { join } from "node:path";
import { configuration } from "../src/config.ts";
import { Consensus } from "../src/consensus.ts";
import { Controller } from "../src/controller.ts";
import { Infrastructure } from "../src/docker.ts";
import { type Manifest, Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { SnapshotJournal, SnapshotOperationError } from "../src/snapshot_operations.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import type { CapturedState, SavedState } from "../src/snapshot_types.ts";
import { fileInventory } from "../src/storage.ts";
import { Timeline } from "../src/time.ts";

/** Controller/storage boundaries only; real client compatibility is covered by the public suite. */
async function fixture(
  run: (f: {
    controller: Controller;
    snapshots: SnapshotStore;
    journal: SnapshotJournal;
    snapshot: Awaited<ReturnType<SnapshotStore["capture"]>>;
    saved: SavedState;
    events: string[];
  }) => Promise<void>,
) {
  const base = await Deno.makeTempDir({ prefix: "snapshot-controller-" });
  const prior = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  const originals = {
    start: Network.prototype.start,
    preserve: Network.prototype.preserve,
    fail: Network.prototype.fail,
    discard: Network.prototype.discard,
    startCandidate: Network.prototype.startCandidate,
    commitCandidate: Network.prototype.commitCandidate,
    activateValidator: Network.prototype.activateValidator,
    assertGenerationUnused: Infrastructure.prototype.assertGenerationUnused,
    connect: Consensus.connect,
  };
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let controller: Controller | undefined;
  try {
    const events: string[] = [];
    const bake = await readBake("gloas", "snapshot-minimal-r1");
    const config = configuration({ id: "controller-snapshot", profile: "gloas", bake: bake.tag });
    const network = new Network(config);
    const source = await network.store.create(config, bake.key);
    network.generation = source;
    const path = network.store.generationPath(source.generation);
    for (const name of ["metadata", "jwt", "validator-keys"]) {
      await Deno.mkdir(join(path, "shared", name));
      await Deno.writeTextFile(join(path, "shared", name, "data"), name);
    }
    await Deno.writeTextFile(join(path, "el", "data"), "execution");
    await Deno.writeTextFile(join(path, "bn", "data"), "consensus");
    const hash = `0x${"12".repeat(32)}`;
    const zero = `0x${"00".repeat(32)}`;
    const saved: SavedState = {
      schema: 2,
      nowMs: config.genesisTime * 1000 + 11_500,
      slot: 0,
      headSlot: 0,
      headBlockRoot: hash,
      headStateRoot: hash,
      executionBlockHash: hash,
      executionBlockNumber: 0,
      finalizedEpoch: 0,
      finalizedRoot: zero,
      replayMessages: [],
      databaseFiles: {
        el: await fileInventory(join(path, "el")),
        bn: await fileInventory(join(path, "bn")),
      },
      sharedFiles: Object.fromEntries(
        await Promise.all(
          ["metadata", "jwt", "validator-keys"].map(async (
            name,
          ) => [name, await fileInventory(join(path, "shared", name))]),
        ),
      ) as SavedState["sharedFiles"],
    };
    source.phase = "stopped";
    source.checkpoint = saved;
    await network.store.write(source);
    network.infra.docker.listContainers = (() =>
      Promise.resolve([])) as typeof network.infra.docker.listContainers;
    Infrastructure.prototype.assertGenerationUnused = () => Promise.resolve();
    const snapshots = new SnapshotStore(network.store, network.infra);
    const snapshot = await snapshots.capture(bake);
    await network.store.write({ ...source, phase: "running" });
    server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/bn-clock" || url.pathname === "/vc-clock") {
        return Response.json({ nowMs: saved.nowMs, marks: {} });
      }
      if (request.method === "POST") {
        const body = await request.json();
        const result = body.method === "txpool_status"
          ? { pending: "0x0", queued: "0x0" }
          : body.method === "txpool_content"
          ? { pending: {}, queued: {} }
          : { hash, number: "0x0", timestamp: `0x${config.genesisTime.toString(16)}` };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }
      const data = url.pathname === "/eth/v1/beacon/headers/head"
        ? { canonical: true, root: hash, header: { message: { slot: "0", state_root: hash } } }
        : url.pathname.startsWith("/eth/v2/beacon/blocks/")
        ? {
          message: {
            slot: "0",
            body: {
              signed_execution_payload_bid: {
                message: { block_hash: zero, parent_block_hash: hash },
              },
            },
          },
        }
        : url.pathname === "/eth/v1/beacon/states/head/root"
        ? { root: hash }
        : url.pathname.endsWith("/finality_checkpoints")
        ? { finalized: { epoch: "0", root: zero } }
        : { is_syncing: false, is_optimistic: false, el_offline: false };
      return Response.json({ execution_optimistic: false, data });
    });
    const url = `http://127.0.0.1:${server.addr.port}`;
    const manifest: Manifest = {
      config,
      bake,
      directory: network.directory,
      el: url,
      beacon: url,
      bnClock: `${url}/bn-clock`,
      vcClock: `${url}/vc-clock`,
      vc: url,
    };
    const timeline = () =>
      new Timeline(config.genesisTime * 1000, saved.nowMs, { move: () => Promise.resolve() });
    Network.prototype.start = async function () {
      events.push("resume");
      this.generation = await this.store.resumable();
      await this.store.write({ ...this.generation, phase: "running" });
      return { ...manifest, directory: this.directory };
    };
    Network.prototype.preserve = async function (captured: CapturedState) {
      events.push("preserve");
      this.generation = {
        ...this.generation!,
        phase: "stopped",
        checkpoint: { ...saved, ...captured },
      };
      await this.store.write(this.generation);
    };
    Network.prototype.discard = async function () {
      events.push("discard");
      if (this.generation) await this.store.write({ ...this.generation, phase: "faulted" });
    };
    Network.prototype.startCandidate = function (candidate) {
      events.push("candidate-start");
      this.generation = candidate;
      return Promise.resolve({
        ...manifest,
        generation: candidate.generation,
        directory: this.directory,
      });
    };
    Network.prototype.commitCandidate = async function () {
      events.push("commit");
      await this.store.write(this.generation!);
    };
    Network.prototype.activateValidator = () => {
      events.push("validator");
      return Promise.resolve();
    };
    Network.prototype.fail = async function () {
      events.push("fail");
      if ((await this.store.active())?.generation === this.generation?.generation) {
        await this.store.write({ ...this.generation!, phase: "faulted" });
      }
    };
    Consensus.connect = () => Promise.resolve(timeline());
    controller = new Controller(network, manifest, timeline());
    await run({
      controller,
      snapshots,
      snapshot,
      journal: new SnapshotJournal(network.store),
      saved,
      events,
    });
  } finally {
    Object.assign(Network.prototype, {
      start: originals.start,
      preserve: originals.preserve,
      fail: originals.fail,
      discard: originals.discard,
      startCandidate: originals.startCandidate,
      commitCandidate: originals.commitCandidate,
      activateValidator: originals.activateValidator,
    });
    Infrastructure.prototype.assertGenerationUnused = originals.assertGenerationUnused;
    Consensus.connect = originals.connect;
    try {
      await controller?.automine.stop();
    } catch { /* A failed replacement has no active session. */ }
    await server?.shutdown();
    if (prior === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", prior);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("restore rejects damaged data before stopping the healthy source", async () => {
  await fixture(async ({ controller, snapshots, snapshot, events }) => {
    await Deno.writeTextFile(
      join(await snapshots.store.snapshotsDirectory(), snapshot.id, "data/el/data"),
      "damaged",
    );
    await assert.rejects(controller.restoreSnapshot(snapshot.id), /integrity/);
    assert.deepEqual(events, []);
    assert.equal(controller.lifecycle().ready, true);
  });
});

Deno.test("failed restore preparation cleans its allocated copy and leaves source ready", async () => {
  await fixture(async ({ controller, snapshots, snapshot, events, journal }) => {
    const copy = Deno.copyFile;
    Deno.copyFile = () => Promise.reject(new Error("copy disk full"));
    const id = crypto.randomUUID();
    try {
      await assert.rejects(controller.restoreSnapshot(snapshot.id, id), /copy disk full/);
    } finally {
      Deno.copyFile = copy;
    }
    const record = await journal.read(id);
    assert.ok(record?.candidateGeneration);
    await assert.rejects(
      Deno.stat(snapshots.store.generationPath(record.candidateGeneration)),
      Deno.errors.NotFound,
    );
    assert.deepEqual(events, []);
    assert.equal(controller.lifecycle().ready, true);
  });
});

Deno.test("failed snapshot copy resumes the clean source and restores readiness", async () => {
  await fixture(async ({ controller, events, snapshots }) => {
    const copy = Deno.copyFile;
    Deno.copyFile = () => Promise.reject(new Error("capture disk full"));
    const id = crypto.randomUUID();
    try {
      await assert.rejects(controller.createSnapshot(id), /capture disk full/);
    } finally {
      Deno.copyFile = copy;
    }
    assert.deepEqual(events, ["preserve", "resume"]);
    assert.equal(controller.lifecycle().ready, true);
    await assert.rejects(snapshots.read(id), Deno.errors.NotFound);
  });
});

Deno.test("published snapshot survives source resume failure and is in the durable error", async () => {
  await fixture(async ({ controller, snapshots, journal, events }) => {
    Network.prototype.start = () => Promise.reject(new Error("source resume failure"));
    const id = crypto.randomUUID();
    await assert.rejects(controller.createSnapshot(id), (error) => {
      assert(error instanceof SnapshotOperationError);
      assert.equal(error.operation.snapshot?.id, id);
      return /source resume failure/.test(error.message);
    });
    assert.equal((await journal.read(id))?.snapshot?.id, id);
    await snapshots.read(id);
    assert.deepEqual(events, ["preserve"]);
    assert.equal(controller.lifecycle().ready, false);
  });
});

Deno.test("lost successful response reuses the recorded snapshot without repeating work", async () => {
  await fixture(async ({ controller, snapshots, events }) => {
    const id = crypto.randomUUID();
    const saved = await controller.createSnapshot(id);
    const repeated = await controller.createSnapshot(id);
    assert.deepEqual(repeated, saved);
    assert.deepEqual(events, ["preserve", "resume"]);
    await snapshots.read(id);
    assert.equal(controller.lifecycle().ready, true);
  });
});

Deno.test("lost commit acknowledgement cannot start validators or roll back active authority", async () => {
  await fixture(async ({ controller, snapshot, journal, events, snapshots }) => {
    Network.prototype.commitCandidate = async function () {
      events.push("commit");
      await this.store.write(this.generation!);
      throw new Error("lost commit acknowledgement");
    };
    const id = crypto.randomUUID();
    await assert.rejects(
      controller.restoreSnapshot(snapshot.id, id),
      /lost commit acknowledgement/,
    );
    const record = await journal.read(id);
    assert.equal((await snapshots.store.active())?.generation, record?.candidateGeneration);
    assert.deepEqual(events, ["discard", "candidate-start", "commit", "fail"]);
    assert.equal(controller.lifecycle().ready, false);
    await snapshots.read(snapshot.id);
  });
});

Deno.test("external snapshot startup preserves the original candidate failure", async () => {
  await fixture(async ({ snapshots, snapshot }) => {
    const exported = await snapshots.export(snapshot.id);
    const copy = Infrastructure.prototype.copySnapshot;
    Infrastructure.prototype.copySnapshot = function (...args) {
      this.docker.listContainers = (() => Promise.resolve([])) as typeof this.docker.listContainers;
      return copy.apply(this, args);
    };
    Network.prototype.discard = function () {
      this.releaseRecovery();
      return Promise.resolve();
    };
    Network.prototype.startCandidate = function (candidate) {
      this.generation = candidate;
      return Promise.reject(new Error("original candidate failure"));
    };
    try {
      await assert.rejects(
        Controller.fromSnapshot(exported.path, { id: "external-start" }),
        /original candidate failure/,
      );
    } finally {
      Infrastructure.prototype.copySnapshot = copy;
      await exported.cleanup();
    }
  });
});

Deno.test("cleanup failure stays visible in the completed snapshot operation", async () => {
  await fixture(async ({ controller, journal }) => {
    const cleanup = Network.prototype.cleanupSnapshotData;
    Network.prototype.cleanupSnapshotData = () => Promise.reject(new Error("cleanup denied"));
    const id = crypto.randomUUID();
    try {
      await controller.createSnapshot(id);
      const record = await journal.read(id);
      assert.equal(record?.state, "succeeded");
      assert.equal(record?.cleanup?.state, "failed");
      assert.match(record!.cleanup!.error!, /cleanup denied/);
      assert.equal(controller.lifecycle().ready, true);
    } finally {
      Network.prototype.cleanupSnapshotData = cleanup;
    }
  });
});

Deno.test("unsupported public Beacon writes keep forwarding but refuse snapshots before stop", async (t) => {
  for (
    const path of [
      "/eth/v2/beacon/blocks",
      "/eth/v1/beacon/execution_payload_envelopes",
      "/eth/v2/validator/aggregate_and_proofs",
      "/eth/v1/validator/prepare_beacon_proposer",
      "/cl/lighthouse/new_mutating_endpoint",
      "/vc/eth/v1/keystores",
    ]
  ) {
    await t.step(path, () =>
      fixture(async ({ controller, events, snapshot }) => {
        const url = controller.serve(0);
        try {
          const response = await fetch(url + path, { method: "POST", body: "[]" });
          assert.equal(response.status, 200, "snapshot limitation changed native forwarding");
          await response.text();
          await assert.rejects(
            controller.createSnapshot(),
            /Untracked (Beacon|validator) mutation/,
          );
          assert.deepEqual(events, [], "unsupported capture stopped the healthy source");
          assert.equal(controller.lifecycle().ready, true, "snapshot refusal disabled network use");
          // Explicit restoration selects a verified state and clears the old session limitation.
          await controller.restoreSnapshot(snapshot.id);
          await controller.createSnapshot();
        } finally {
          await controller.server?.shutdown();
        }
      }));
  }
});

Deno.test("faulted ingress cannot be cleared by creating or preserving a snapshot", async () => {
  await fixture(async ({ controller, events, snapshot }) => {
    controller.ingress.fault(new Error("unresolved execution submission"));
    await assert.rejects(
      controller.createSnapshot(),
      /faulted|uncertain|recovery|not ready|restore explicitly/i,
    );
    await assert.rejects(
      controller.preserve(),
      /faulted|uncertain|recovery|not ready|restore explicitly/i,
    );
    assert.deepEqual(events, [], "capture stopped an uncertain source");
    assert.equal(controller.lifecycle().ready, false);
    await controller.restoreSnapshot(snapshot.id);
    assert.equal(controller.lifecycle().ready, true);
  });
});

Deno.test("graceful shutdown waits for snapshot creation and rejects new lifecycle work", async () => {
  await fixture(async ({ controller, snapshots, events }) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const preserve = Network.prototype.preserve;
    Network.prototype.preserve = async function (...args) {
      entered.resolve();
      await release.promise;
      return await preserve.apply(this, args);
    };
    const creation = controller.createSnapshot();
    await entered.promise;
    const closing = controller.closePreserving();
    // Observe the real rejected/finished shutdown path without leaving an unhandled rejection.
    let closed = false;
    const observed = closing.then(() => {
      closed = true;
    }, () => {
      closed = true;
    });
    try {
      await assert.rejects(controller.createSnapshot(), /stopping|progress|closing/i);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(closed, false, "shutdown completed while capture still owned the source");
      assert.equal(events.includes("fail"), false, "shutdown faulted an active snapshot operation");
      release.resolve();
      const snapshot = await creation;
      await closing;
      await snapshots.read(snapshot.id);
      assert.deepEqual(events, ["preserve", "resume", "preserve"]);
      assert.equal(controller.lifecycle().ready, false);
    } finally {
      release.resolve();
      await Promise.allSettled([creation, closing, observed]);
    }
  });
});

Deno.test("graceful recovery shutdown cleans abandoned clients without destroying retained state", async () => {
  const events: string[] = [];
  const config = configuration({
    profile: "gloas",
    bake: "snapshot-minimal-r1",
    id: "recovery-close",
  });
  const network = {
    config,
    fail: (_error: unknown, scope: "generation" | "network" = "generation") => {
      assert.equal(scope, "network", "abandoned candidate clients also belong to this owner");
      events.push("cleanup-runtime-keep-data");
      return Promise.resolve();
    },
    releaseRecovery: () => {
      events.push("release-only");
    },
    stop: () => {
      throw new Error("Recovery shutdown must retain the generation");
    },
  } as unknown as Network;
  const controller = new Controller(network, await readBake(config.profile, config.bake));
  await controller.closePreserving();
  assert.deepEqual(events, ["cleanup-runtime-keep-data"]);
});
