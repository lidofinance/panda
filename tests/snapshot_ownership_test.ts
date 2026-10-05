import assert from "node:assert/strict";
import { Controller } from "../src/controller.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { StateLock, StateStore } from "../src/storage.ts";

Deno.test("snapshot startup holds controller ownership before import and releases it on failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "snapshot-owner-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", root);
  const id = "snapshot-owner";
  const store = new StateStore(id);
  const importSnapshot = SnapshotStore.prototype.import;
  let imports = 0;
  SnapshotStore.prototype.import = () => {
    imports++;
    return Promise.reject(new Error("test import reached"));
  };
  let owner: StateLock | undefined;
  try {
    await store.initialize();
    owner = await StateLock.acquire(`${store.root}/controller.owner`);
    await assert.rejects(Controller.fromSnapshot("unused-source", { id }), /owned by live process/);
    await assert.rejects(Controller.start({ id }), /owned by live process/);
    assert.equal(imports, 0, "snapshot import started before obtaining controller ownership");
    owner.release();
    owner = undefined;
    await assert.rejects(Controller.fromSnapshot("unused-source", { id }), /test import reached/);
    assert.equal(imports, 1);
    const released = await StateLock.acquire(`${store.root}/controller.owner`);
    released.release();
    assert.equal(await store.active(), undefined);
  } finally {
    owner?.release();
    SnapshotStore.prototype.import = importSnapshot;
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true });
  }
});
