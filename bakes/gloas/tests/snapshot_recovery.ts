/** Abrupt controller loss at durable snapshot boundaries, against real EL/CL clients. */
import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { Controller } from "../../../src/controller.ts";
import { Infrastructure, LABEL, ROLE } from "../../../src/docker.ts";
import { deadline } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { SnapshotJournal } from "../../../src/snapshot_operations.ts";
import { SnapshotStore } from "../../../src/snapshots.ts";
import { StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { assertSnapshotPtc, snapshotBeaconState, snapshotTransaction } from "./snapshots.ts";

const stages = ["captured", "candidate-verified", "committed"] as const;
type Cut = typeof stages[number];
const exitCode = 73;

async function crashChild(id: string, snapshot: string, operation: string, stage: Cut) {
  const store = new StateStore(id);
  const active = await store.active();
  assert(active, "crash worker requires a retained source");
  const controller = await Controller.start(active.config, "resume");
  const update = SnapshotJournal.prototype.update;
  SnapshotJournal.prototype.update = async function (record, changes) {
    await update.call(this, record, changes);
    if (record.id === operation && record.stage === stage) {
      // Test-only abrupt exit, after the real production journal has fsynced the stage.
      // No client cleanup/finally runs. Docker clients and the active pointer remain as-is.
      Deno.stdout.writeSync(new TextEncoder().encode(
        JSON.stringify({ event: "snapshot-crash-cut", operation, stage }) + "\n",
      ));
      Deno.exit(exitCode);
    }
  };
  try {
    if (stage === "captured") await controller.createSnapshot(operation);
    else await controller.restoreSnapshot(snapshot, operation);
    throw new Error(`Crash cut was not reached: ${stage}`);
  } finally {
    SnapshotJournal.prototype.update = update;
    await controller.close();
  }
}

async function crashAt(
  id: string,
  snapshot: string,
  operation: string,
  stage: Cut,
  evidence: string,
) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config=deno.json",
      "-A",
      import.meta.filename!,
      "--child",
      id,
      snapshot,
      operation,
      stage,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = child.output();
  let result: Deno.CommandOutput;
  try {
    result = await deadline(output, 180_000, `snapshot controller crash at ${stage}`);
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch (failure) {
      if (!(failure instanceof Deno.errors.NotFound)) throw failure;
    }
    const partial = await output;
    await Deno.writeFile(`${evidence}/${stage}.stdout.log`, partial.stdout);
    await Deno.writeFile(`${evidence}/${stage}.stderr.log`, partial.stderr);
    throw error;
  }
  await Deno.writeFile(`${evidence}/${stage}.stdout.log`, result.stdout);
  await Deno.writeFile(`${evidence}/${stage}.stderr.log`, result.stderr);
  assert.equal(result.code, exitCode, new TextDecoder().decode(result.stderr));
  const reached = new TextDecoder().decode(result.stdout).split("\n").some((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.event === "snapshot-crash-cut" && entry.operation === operation &&
        entry.stage === stage;
    } catch {
      return false;
    }
  });
  assert(reached, "worker did not confirm the exact durable cut");
}

export async function runSnapshotRecovery() {
  const id = `snapshot-cuts-${crypto.randomUUID().slice(0, 8)}`;
  const store = new StateStore(id);
  const infra = new Infrastructure(id);
  const evidence = `.cache/snapshot-recovery/${crypto.randomUUID()}`;
  await Deno.mkdir(evidence, { recursive: true });
  const began = performance.now();
  const cuts = [];
  let controller: Controller | undefined;
  let passed = false;
  try {
    controller = await Controller.start({ id, profile: "gloas" });
    const first = new Devnet(controller.serve(0));
    await first.advanceSlots(3);
    const before = await first.status();
    const block = await first.beacon("/eth/v2/beacon/blocks/head");
    const state = await snapshotBeaconState(first.url);
    const baseline = await first.createSnapshot();
    await controller.closePreserving();
    controller = undefined;
    await first.close();

    for (const stage of stages) {
      const source = (await store.active())!.generation;
      const operation = crypto.randomUUID();
      const started = performance.now();
      await crashAt(id, baseline.id, operation, stage, evidence);
      const record = await new SnapshotJournal(store).read(operation);
      assert(record);
      assert.equal(record.state, "running");
      assert.equal(record.stage, stage);
      const active = (await store.active())!;
      assert.equal(active.generation, stage === "committed" ? record.candidateGeneration : source);
      assert.equal(
        active.phase,
        stage === "captured" ? "stopped" : stage === "committed" ? "starting" : "faulted",
      );
      const clients = await infra.docker.listContainers({
        all: true,
        filters: { label: [`${LABEL}=${id}`] },
      });
      assert.deepEqual(
        clients.map((client) => client.Labels[ROLE]).sort(),
        stage === "captured" ? [] : ["bn", "el"],
        "candidate signed before commit or old clients survived replacement",
      );
      const snapshot = stage === "captured" ? record.snapshot : baseline;
      assert(snapshot, "completed snapshot publication was lost");
      await new SnapshotStore(store, infra).read(snapshot.id);
      controller = await Controller.recover(active.config);
      const net = new Devnet(controller.serve(0));
      try {
        assert.equal((await net.lifecycle()).ready, false);
        assert.equal((await net.lifecycle()).recoveryRequired, true);
        await assert.rejects(net.stepSlot(), /recovery|faulted|unavailable/i);
        if (stage === "captured") {
          await assert.rejects(net.createSnapshot(operation), /interrupted/i);
        } else await assert.rejects(net.restoreSnapshot(snapshot, operation), /interrupted/i);
        assert.equal(
          (await store.active())!.generation,
          active.generation,
          "retry silently changed the authoritative branch",
        );
        const restored = await net.restoreSnapshot(snapshot);
        assert.notEqual(restored.generation, active.generation);
        assert.equal((await net.lifecycle()).ready, true);
        const current = await net.status();
        assert.equal(current.now, before.now);
        assert.deepEqual(current.el, before.el);
        assert.deepEqual(await net.beacon("/eth/v2/beacon/blocks/head"), block);
        assert.deepEqual(await snapshotBeaconState(net.url), state);
        const transaction = await snapshotTransaction(net);
        assert.equal(
          Number(BigInt(transaction.receipt.blockNumber)),
          Number(BigInt(before.el.number)) + 1,
        );
        await assertSnapshotPtc(net, before.slot + 1);
        await net.stepSlot();
        await assertSnapshotPtc(net, before.slot + 2);
        await controller.closePreserving();
        controller = undefined;
        cuts.push({
          stage,
          elapsedMs: performance.now() - started,
          restoredSlot: before.slot,
          verifiedNextSlots: [before.slot + 1, before.slot + 2],
        });
        console.log(JSON.stringify({ event: "snapshot-crash-recovery-passed", stage }));
      } finally {
        await net.close();
      }
    }
    await profileReport(before, "snapshot-recovery", {
      passed: true,
      cuts,
      elapsedMs: performance.now() - began,
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
    if (passed) await Deno.remove(store.root, { recursive: true });
  }
}

if (import.meta.main) {
  if (Deno.args[0] === "--child") {
    const [, id, snapshot, operation, stage] = Deno.args;
    assert(stages.includes(stage as Cut), "unknown snapshot crash cut");
    await crashChild(id, snapshot, operation, stage as Cut);
  } else await runSnapshotRecovery();
}
