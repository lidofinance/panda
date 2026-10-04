import assert from "node:assert/strict";
import { join } from "node:path";
import { SnapshotJournal, SnapshotOperationError } from "../src/snapshot_operations.ts";
import { StateStore } from "../src/storage.ts";

async function fixture(run: (journal: SnapshotJournal) => Promise<void>) {
  const base = await Deno.makeTempDir({ prefix: "panda-snapshot-operations-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  try {
    const store = new StateStore("snapshot-operations");
    await store.initialize();
    await run(new SnapshotJournal(store));
  } finally {
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("durable snapshot outcomes survive a new journal and never repeat completed work", async () => {
  await fixture(async (journal) => {
    const id = crypto.randomUUID();
    const request = { kind: "create" as const };
    const value = { snapshot: "saved", time: 123 };
    let called = 0;
    await journal.run(id, request, async (record, interrupted) => {
      called++;
      assert.equal(interrupted, false);
      assert.equal((await journal.read(id))?.state, "running");
      await journal.update(record, { stage: "captured" });
      return value;
    });
    const reopened = new SnapshotJournal(journal.store);
    assert.deepEqual(
      await reopened.run(id, request, () => {
        called++;
        throw new Error("Repeated operation");
      }),
      value,
    );
    assert.equal(called, 1);
    const before = await reopened.read(id);
    await assert.rejects(
      reopened.run(id, { kind: "restore", snapshotId: id }, () => Promise.resolve()),
      /different request/,
    );
    assert.deepEqual(await reopened.read(id), before);
  });
});

Deno.test("snapshot failure retains its durable stage and is queryable without clients", async () => {
  await fixture(async (journal) => {
    const id = crypto.randomUUID();
    const work = () =>
      journal.run(id, { kind: "create" }, async (record) => {
        await journal.update(record, { stage: "captured", sourceGeneration: "source" });
        throw new Error("source resume failed");
      });
    await assert.rejects(
      work(),
      (error) => error instanceof SnapshotOperationError && error.operation.stage === "captured",
    );
    const saved = await journal.read(id);
    assert.equal(saved?.state, "failed");
    const reopened = new SnapshotJournal(journal.store);
    await assert.rejects(
      reopened.run(id, { kind: "create" }, () => {
        throw new Error("Must not repeat failure");
      }),
      /source resume failed/,
    );
    assert.deepEqual(await reopened.read(id), saved);
  });
});

Deno.test("an unfinished journal hands its exact stage to explicit recovery", async () => {
  await fixture(async (journal) => {
    const id = crypto.randomUUID();
    const record = {
      schema: 1 as const,
      owner: journal.store.id,
      id,
      request: { kind: "restore" as const, snapshotId: crypto.randomUUID() },
      state: "running" as const,
      stage: "committed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      candidateGeneration: crypto.randomUUID(),
    };
    await journal.update(record, {});
    const result = await new SnapshotJournal(journal.store).run(
      id,
      record.request,
      (saved, interrupted) => {
        assert.equal(interrupted, true);
        assert.equal(saved.stage, "committed");
        assert.equal(saved.candidateGeneration, record.candidateGeneration);
        return Promise.resolve({ recovered: true });
      },
    );
    assert.deepEqual(result, { recovered: true });
  });
});

Deno.test("another process cannot mutate the snapshot journal while its owner is working", async () => {
  await fixture(async (journal) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = journal.run(crypto.randomUUID(), { kind: "create" }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      await assert.rejects(
        new SnapshotJournal(journal.store).run(
          crypto.randomUUID(),
          { kind: "create" },
          () => Promise.resolve(),
        ),
        /owned by live process/,
      );
    } finally {
      release.resolve();
    }
    await first;
  });
});

Deno.test("journal rejects unsafe IDs and symlinked records", async () => {
  await fixture(async (journal) => {
    await assert.rejects(journal.read("../../outside"), /UUID/);
    const id = crypto.randomUUID();
    await journal.run(id, { kind: "create" }, () => Promise.resolve(null));
    const path = join(journal.store.root, "operations", `${id}.json`);
    await Deno.rename(path, `${path}.outside`);
    await Deno.symlink(`${path}.outside`, path);
    await assert.rejects(journal.read(id), /Unsafe/);
  });
});
