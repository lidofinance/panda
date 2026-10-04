import assert from "node:assert/strict";
import { join } from "node:path";
import { Controller } from "../../../src/controller.ts";
import { SnapshotJournal } from "../../../src/snapshot_operations.ts";
import { waitFor } from "../../../src/http.ts";

/** Pause a real controller at a durable journal boundary or a creation filesystem boundary. */
export async function killControllerAtStage(
  id: string,
  snapshot: string,
  operation: string,
  stage: string,
  kind: "create" | "restore" = "restore",
) {
  const directory = `.cache/snapshot-tests/${id}/${operation}/${stage}`;
  await Deno.mkdir(directory, { recursive: true });
  const ready = `${directory}/ready.json`;
  using stdout = await Deno.open(`${directory}/stdout.log`, {
    create: true,
    write: true,
    truncate: true,
  });
  using stderr = await Deno.open(`${directory}/stderr.log`, {
    create: true,
    write: true,
    truncate: true,
  });
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config=deno.json",
      "-A",
      new URL(import.meta.url).pathname,
      id,
      snapshot,
      operation,
      stage,
      ready,
      kind,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const pipes = Promise.all([
    child.stdout.pipeTo(stdout.writable, { preventClose: true }),
    child.stderr.pipeTo(stderr.writable, { preventClose: true }),
  ]);
  let exited: Deno.CommandStatus | undefined;
  const status = child.status.then((value) => exited = value);
  try {
    await waitFor(`snapshot controller cut at ${stage}`, async () => {
      if (exited) throw new Error(`Snapshot child exited ${exited.code}; inspect ${directory}`);
      try {
        await Deno.stat(ready);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
    }, 120_000);
    child.kill("SIGKILL");
    await status;
    assert.equal(exited!.signal, "SIGKILL");
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
      await status;
    }
    await pipes;
  }
}

if (import.meta.main) {
  const [id, snapshot, operation, stage, ready, kind] = Deno.args;
  const pause = async (): Promise<never> => {
    await Deno.writeTextFile(ready, JSON.stringify({ stage }));
    return await new Promise(() => {});
  };
  const update = SnapshotJournal.prototype.update;
  SnapshotJournal.prototype.update = async function (record, changes) {
    await update.call(this, record, changes);
    if (record.id === operation && record.stage === stage) {
      await pause();
    }
  };
  const controller = await Controller.start({ id }, "auto");
  controller.serve(0);
  if (kind === "create") {
    const parent = await controller.network.store.snapshotsDirectory();
    const pending = join(parent, `.pending-${operation}`);
    const final = join(parent, operation);
    const rename = Deno.rename;
    Deno.rename = async (from, to) => {
      const publishing = String(from) === pending && String(to) === final;
      if (publishing && stage === "before-publication") await pause();
      await rename(from, to);
      if (publishing && stage === "after-publication") await pause();
      if (String(to) === join(pending, "manifest.json") && stage === "manifest-written") {
        await pause();
      }
    };
    const copy = Deno.copyFile;
    Deno.copyFile = async (from, to) => {
      await copy(from, to);
      // The source is already stopped. Kill after the first actual BN file was copied, while
      // the remaining tree and archive manifest are still incomplete.
      if (stage === "partial-copy" && String(to).includes("/bn/")) await pause();
    };
    await controller.createSnapshot(operation);
  } else await controller.restoreSnapshot(snapshot, operation);
}
