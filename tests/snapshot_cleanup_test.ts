import assert from "node:assert/strict";
import { join } from "node:path";
import { configuration } from "../src/config.ts";
import { GENERATION, LABEL } from "../src/docker.ts";
import { Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { SnapshotJournal, type SnapshotOperation } from "../src/snapshot_operations.ts";
import { type ActiveGeneration, fileInventory, StateLock, treeMetadata } from "../src/storage.ts";

async function fixture(
  run: (context: {
    network: Network;
    active: ActiveGeneration;
    candidate: ActiveGeneration;
    records: SnapshotOperation[];
  }) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "panda-cleanup-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", root);
  const bake = await readBake("gloas", "p3-checkpoint-r5");
  const network = new Network(configuration({ id: "cleanup-owner", bake: bake.tag }));
  const { store } = network;
  try {
    const active = await store.create(network.config, bake.key);
    const journal = new SnapshotJournal(store);
    let candidate: ActiveGeneration;
    await journal.run(
      crypto.randomUUID(),
      { kind: "restore", snapshotId: crypto.randomUUID() },
      async (record) => {
        candidate = await store.allocate(network.config, bake.key, async (value) => {
          await journal.update(record, {
            candidateGeneration: value.generation,
            sourceGeneration: active.generation,
          });
        });
        await Deno.writeTextFile(
          join(store.generationPath(candidate.generation), "el", "db"),
          "discarded state",
        );
      },
    );
    network.infra.docker.listContainers = (() =>
      Promise.resolve([])) as typeof network.infra.docker.listContainers;
    await network.enterRecovery();
    const journalLock = await StateLock.acquire(join(store.root, "snapshot-operation.lock"));
    try {
      await run({ network, active, candidate: candidate!, records: await journal.list() });
    } finally {
      journalLock.release();
    }
  } finally {
    network.releaseRecovery();
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("snapshot cleanup protects active authority and every generation with a client container", async () => {
  await fixture(async ({ network, active, candidate, records }) => {
    const { store, infra } = network;
    const before = await fileInventory(store.generationPath(active.generation));
    const clients = infra.docker.listContainers;
    infra.docker.listContainers = ((options: { filters: { label: string[] } }) => {
      assert.deepEqual(options.filters.label, [
        `${LABEL}=${store.id}`,
        `${GENERATION}=${candidate.generation}`,
      ]);
      return Promise.resolve([{ Id: "retained-client", State: "exited" }]);
    }) as typeof clients;
    await assert.rejects(network.cleanupSnapshotData(records), /still has client containers/);
    await store.validate(candidate);
    assert.deepEqual(await fileInventory(store.generationPath(active.generation)), before);
    infra.docker.listContainers = clients;
    await network.cleanupSnapshotData(records);
    await assert.rejects(
      Deno.stat(store.generationPath(candidate.generation)),
      Deno.errors.NotFound,
    );
    assert.deepEqual(await store.active(), active);
    await assert.rejects(
      store.discardInactive(active.generation, true, async () => {}),
      /active generation/,
    );
  });
});

Deno.test("down refuses a busy snapshot journal before stopping clients or deleting active data", async () => {
  await fixture(async ({ network, active }) => {
    let stops = 0;
    network.saveLogs = () => Promise.resolve();
    network.infra.cleanup = () => {
      stops++;
      return Promise.resolve();
    };
    await assert.rejects(network.stop(), /owned by live process/);
    assert.equal(stops, 0, "down stopped clients before acquiring snapshot operation ownership");
    assert.deepEqual(await network.store.active(), active);
  });
});

Deno.test("cleanup removes a crashed client's Unix socket while archive inventory still refuses it", async () => {
  await fixture(async ({ network, active, candidate, records }) => {
    const path = network.store.generationPath(candidate.generation);
    // Bind a short pathname to fit sockaddr_un even when the checkout/temp root is long.
    const socket = `/tmp/panda-ipc-${crypto.randomUUID()}`;
    const listener = Deno.listen({ transport: "unix", path: socket });
    try {
      await Deno.rename(socket, join(path, "el", "geth.ipc"));
    } finally {
      listener.close();
      await Deno.remove(socket).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
    assert.equal((await Deno.lstat(join(path, "el", "geth.ipc"))).isSocket, true);
    await assert.rejects(fileInventory(path), /Unsupported/);
    await assert.rejects(treeMetadata(path), /Unsupported/);
    await network.cleanupSnapshotData(records);
    await assert.rejects(Deno.lstat(path), Deno.errors.NotFound);
    assert.deepEqual(await network.store.active(), active);
  });
});

Deno.test("snapshot cleanup refuses unsafe ownership and links without deleting their targets", async (t) => {
  for (const fault of ["record owner", "generation owner", "directory link", "nested link"]) {
    await t.step(fault, async () => {
      await fixture(async ({ network, active, candidate, records }) => {
        const { store } = network;
        const path = store.generationPath(candidate.generation);
        const outside = join(store.root, "unrelated");
        await Deno.mkdir(outside);
        await Deno.writeTextFile(join(outside, "keep"), "do not delete");
        if (fault === "record owner") records[0].owner = "another-owner";
        if (fault === "generation owner") {
          await Deno.writeTextFile(
            join(path, "owner.json"),
            JSON.stringify({ schema: 1, id: "another-owner", generation: candidate.generation }),
          );
        }
        if (fault === "directory link") {
          await Deno.rename(path, `${path}.evidence`);
          await Deno.symlink(outside, path);
        }
        if (fault === "nested link") await Deno.symlink(outside, join(path, "el", "link"));
        await assert.rejects(network.cleanupSnapshotData(records), /ownership|Unsafe|Unsupported/);
        assert.equal(await Deno.readTextFile(join(outside, "keep")), "do not delete");
        assert.deepEqual(await store.active(), active);
        await Deno.lstat(path);
      });
    });
  }
});

Deno.test("generation cleanup resumes after rename acknowledgement, partial unlink and directory sync failures", async (t) => {
  for (const fault of ["rename acknowledgement", "partial unlink", "directory sync"]) {
    await t.step(fault, async () => {
      await fixture(async ({ network, active, candidate, records }) => {
        const { store } = network;
        const parent = join(store.root, "generations");
        const path = store.generationPath(candidate.generation);
        const trash = join(parent, `.discarded-${candidate.generation}`);
        const rename = Deno.rename;
        const remove = Deno.remove;
        const open = Deno.open;
        let renamed = false;
        let injected = false;
        const failure = () => {
          injected = true;
          throw new Error(`injected ${fault}`);
        };
        Deno.rename = async (from, to) => {
          await rename(from, to);
          if (String(from) === path && String(to) === trash) {
            renamed = true;
            if (fault === "rename acknowledgement") failure();
          }
        };
        Deno.remove = async (target, options) => {
          if (String(target) === trash && fault === "partial unlink") {
            await remove(join(trash, "owner.json"));
            await remove(join(trash, "el"), { recursive: true });
            failure();
          }
          await remove(target, options);
        };
        Deno.open = async (target, options) => {
          const file = await open(target, options);
          if (String(target) === parent && renamed && fault === "directory sync") {
            file.sync = failure;
          }
          return file;
        };
        try {
          await assert.rejects(network.cleanupSnapshotData(records), /injected/);
        } finally {
          Deno.rename = rename;
          Deno.remove = remove;
          Deno.open = open;
        }
        assert(injected);
        assert.deepEqual(await store.active(), active);
        await network.cleanupSnapshotData(records);
        await assert.rejects(Deno.stat(path), Deno.errors.NotFound);
        await assert.rejects(Deno.stat(trash), Deno.errors.NotFound);
        assert.deepEqual(await store.active(), active);
      });
    });
  }
});

Deno.test("pending archive cleanup resumes after partial deletion and preserves published and unrecorded paths", async () => {
  await fixture(async ({ network, active, records }) => {
    const { store } = network;
    const record = records[0];
    await new SnapshotJournal(store).update(record, { request: { kind: "create" } });
    const parent = await store.snapshotsDirectory();
    const pending = join(parent, `.pending-${record.id}`);
    const published = join(parent, record.id);
    const unrecorded = join(parent, `.pending-${crypto.randomUUID()}`);
    for (const path of [pending, published, unrecorded]) {
      await Deno.mkdir(path);
      await Deno.writeTextFile(join(path, "manifest.json"), "filesystem fixture");
      await Deno.writeTextFile(join(path, "data"), "preserved bytes");
    }
    const remove = Deno.remove;
    Deno.remove = async (path, options) => {
      if (String(path) === pending) {
        await remove(join(pending, "manifest.json"));
        throw new Error("interrupted pending archive unlink");
      }
      await remove(path, options);
    };
    try {
      await assert.rejects(network.cleanupSnapshotData(records), /pending archive unlink/);
    } finally {
      Deno.remove = remove;
    }
    await network.cleanupSnapshotData(records);
    await assert.rejects(Deno.stat(pending), Deno.errors.NotFound);
    assert.equal(await Deno.readTextFile(join(published, "data")), "preserved bytes");
    assert.equal(await Deno.readTextFile(join(unrecorded, "data")), "preserved bytes");
    assert.deepEqual(await store.active(), active);
  });
});
