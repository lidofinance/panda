import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { Controller } from "../../../src/controller.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { Network } from "../../../src/network.ts";
import { SnapshotStore } from "../../../src/snapshots.ts";
import { fileInventory, StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { killControllerAtStage } from "./snapshot_process.ts";

const id = `snapshot-create-${crypto.randomUUID().slice(0, 8)}`;
const store = new StateStore(id);
const infra = new Infrastructure(id);
const snapshots = new SnapshotStore(store, infra);
const started = performance.now();
const cuts = [];
let controller: Controller | undefined;
let passed = false;
try {
  controller = await Controller.start({ id, profile: "gloas" });
  const initial = new Devnet(controller.serve(0));
  await initial.advanceSlots(3);
  const before = await initial.status();
  const block = await initial.beacon("/eth/v2/beacon/blocks/head");
  // A known-good archive also permits explicit recovery from cuts before the new capture exists.
  const fallback = await initial.createSnapshot();
  await controller.closePreserving();
  await initial.close();
  controller = undefined;
  for (
    const cut of [
      "checkpointing",
      "copying",
      "partial-copy",
      "manifest-written",
      "before-publication",
      "after-publication",
      "captured",
      "completed",
    ]
  ) {
    const operationId = crypto.randomUUID();
    const source = (await store.active())!.generation;
    const cutStarted = performance.now();
    await killControllerAtStage(id, operationId, operationId, cut, "create");
    const active = (await store.active())!;
    assert.equal(active.generation, source, "capture must not change active generation");
    const sourceFiles = active.phase === "stopped"
      ? await fileInventory(store.generationPath(source))
      : undefined;
    if (!["checkpointing", "completed"].includes(cut)) {
      assert.equal(active.phase, "stopped");
      await store.resumable(); // Copy/publication cannot invalidate the verified stopped source.
    }
    const published = ["after-publication", "captured", "completed"].includes(cut);
    assert.equal((await snapshots.list()).some((item) => item.id === operationId), published);
    if (published) await snapshots.read(operationId);
    else await assert.rejects(snapshots.read(operationId), Deno.errors.NotFound);
    controller = await Controller.recover(id);
    const net = new Devnet(controller.serve(0));
    try {
      const lifecycle = await net.lifecycle();
      assert.equal(lifecycle.ready, false);
      assert.equal(lifecycle.recoveryRequired, true);
      assert.equal(lifecycle.now, undefined);
      assert.equal(lifecycle.generation, source);
      const record = await net.snapshotOperation(operationId);
      assert.equal(record?.state, cut === "completed" ? "succeeded" : "running");
      assert.equal(
        record.stage,
        ["checkpointing", "captured", "completed"].includes(cut) ? cut : "copying",
      );
      if (cut === "completed") {
        assert.equal((await net.createSnapshot({ operationId })).id, operationId);
      } else {
        await assert.rejects(net.createSnapshot({ operationId }), /creation was interrupted/);
        const reconciled = (await net.snapshotOperation(operationId))!;
        assert.equal(reconciled.state, "failed");
        assert.equal(reconciled.stage, record.stage);
        assert.equal(reconciled.snapshot?.id, published ? operationId : undefined);
        await assert.rejects(net.createSnapshot({ operationId }), /creation was interrupted/);
      }
      assert.equal((await net.lifecycle()).ready, false, "outcome replay must not resume clients");
      assert.deepEqual(await store.active(), active);
      if (sourceFiles) {
        assert.deepEqual(await fileInventory(store.generationPath(source)), sourceFiles);
      }
      await assert.rejects(net.stepSlot(), /faulted|recovery/);
      await net.restoreSnapshot(published ? operationId : fallback);
      const restored = await net.status();
      assert.equal(restored.now, before.now);
      assert.equal(restored.el.hash, before.el.hash);
      assert.deepEqual(await net.beacon("/eth/v2/beacon/blocks/head"), block);
      await net.stepSlot();
      assert.equal((await net.status()).slot, before.slot + 1);
      // Every following cut starts from the same independent saved state.
      await net.restoreSnapshot(fallback);
      if (published) await net.removeSnapshot(operationId);
      await controller.closePreserving();
      controller = undefined;
      cuts.push({ cut, published, elapsedMs: performance.now() - cutStarted });
      console.log(JSON.stringify({ event: "snapshot-create-cut-passed", cut, published }));
    } finally {
      await net.close();
    }
  }
  await profileReport(before, "snapshot-creation", {
    passed: true,
    cuts,
    elapsedMs: performance.now() - started,
  });
  passed = true;
} finally {
  if (controller) await controller.close();
  else {
    const active = await store.active();
    if (active) await new Network(active.config).stop();
  }
  assert.equal(
    (await infra.docker.listContainers({ all: true, filters: { label: [`${LABEL}=${id}`] } }))
      .length,
    0,
  );
  if (passed) {
    await store.snapshotsDirectory();
    assert.equal(await store.active(), undefined);
    await Deno.remove(store.root, { recursive: true });
  }
}
