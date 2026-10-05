import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { Controller } from "../../../src/controller.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { Network } from "../../../src/network.ts";
import { StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { killControllerAtStage } from "./snapshot_process.ts";

const id = `snapshot-cuts-${crypto.randomUUID().slice(0, 8)}`;
const store = new StateStore(id);
const infra = new Infrastructure(id);
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
  const snapshot = await initial.createSnapshot();
  await controller.closePreserving();
  await initial.close();
  controller = undefined;
  for (
    const stage of [
      "accepted",
      "preparing",
      "partial-copy",
      "prepared",
      "source-stopping",
      "source-stopped",
      "candidate-verified",
      "committed",
      "published",
      "cleanup-renamed",
      "cleanup-unlink",
    ]
  ) {
    const source = (await store.active())!.generation;
    const operationId = crypto.randomUUID();
    const cutStarted = performance.now();
    await killControllerAtStage(id, snapshot.id, operationId, stage);
    controller = await Controller.recover(id);
    const net = new Devnet(controller.serve(0));
    try {
      const lifecycle = await net.lifecycle();
      assert.equal(lifecycle.ready, false);
      assert.equal(lifecycle.recoveryRequired, true);
      assert.equal(lifecycle.now, undefined);
      const record = await net.snapshotOperation(operationId);
      assert.equal(record?.state, "running");
      assert.equal(
        record.stage,
        stage === "partial-copy" ? "preparing" : stage.startsWith("cleanup-") ? "published" : stage,
      );
      if (stage.startsWith("cleanup-")) assert.equal(record.cleanup?.state, "pending");
      assert.equal(
        lifecycle.generation,
        ["committed", "published"].includes(stage) || stage.startsWith("cleanup-")
          ? record.candidateGeneration
          : source,
      );
      await assert.rejects(net.stepSlot(), /faulted|recovery/);
      await assert.rejects(net.restoreSnapshot(snapshot, { operationId }), /interrupted/);
      assert.equal((await net.lifecycle()).generation, lifecycle.generation);
      const restored = await net.restoreSnapshot(snapshot);
      assert.equal((await net.lifecycle()).cleanup?.state, "succeeded");
      const generations = [];
      for await (const entry of Deno.readDir(`${store.root}/generations`)) {
        generations.push(entry.name);
      }
      assert.deepEqual(generations, [restored.generation]);
      const current = await net.status();
      assert.equal(current.now, before.now);
      assert.equal(current.el.hash, before.el.hash);
      assert.deepEqual(await net.beacon("/eth/v2/beacon/blocks/head"), block);
      await net.stepSlot();
      assert.equal((await net.status()).slot, before.slot + 1);
      await controller.closePreserving();
      controller = undefined;
      cuts.push({
        stage,
        elapsedMs: performance.now() - cutStarted,
        generation: restored.generation,
      });
      console.log(JSON.stringify({ event: "snapshot-crash-cut-passed", stage }));
    } finally {
      await net.close();
    }
  }
  await profileReport(before, "snapshot-recovery", {
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
