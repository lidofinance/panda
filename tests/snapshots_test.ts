import assert from "node:assert/strict";
import { join } from "node:path";
import { configuration } from "../src/config.ts";
import { Infrastructure } from "../src/docker.ts";
import { readBake } from "../src/profiles.ts";
import { SnapshotStore } from "../src/snapshots.ts";
import { fileInventory, StateLock, StateStore } from "../src/storage.ts";

async function fixture(
  run: (value: {
    store: StateStore;
    snapshots: SnapshotStore;
    bake: Awaited<ReturnType<typeof readBake>>;
    source: Awaited<ReturnType<StateStore["create"]>>;
  }) => Promise<void>,
) {
  const base = await Deno.makeTempDir({ prefix: "panda-snapshot-test-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  try {
    const bake = await readBake("gloas", "p3-checkpoint-r5");
    const store = new StateStore("snapshot-owner");
    const config = configuration({ id: store.id, profile: bake.profile, bake: bake.tag });
    const source = await store.create(config, bake.key);
    const path = store.generationPath(source.generation);
    for (const name of ["metadata", "jwt", "validator-keys"]) {
      await Deno.mkdir(join(path, "shared", name));
      await Deno.writeTextFile(join(path, "shared", name, "fixture"), name, { mode: 0o600 });
    }
    await Deno.writeTextFile(join(path, "el", "database"), "execution checkpoint");
    await Deno.writeTextFile(join(path, "bn", "database"), "consensus checkpoint");
    await Deno.writeTextFile(join(path, "admission.json"), '{"schema":1,"entries":[]}');
    source.phase = "stopped";
    source.checkpoint = {
      abi: 1,
      nowMs: config.genesisTime * 1000 + 47_500,
      headSlot: 3,
      headBlockRoot: `0x${"12".repeat(32)}`,
      headStateRoot: `0x${"34".repeat(32)}`,
      forkChoiceSlot: 4,
      checkpointHash: `0x${"56".repeat(32)}`,
      databaseFiles: {
        el: await fileInventory(join(path, "el")),
        bn: await fileInventory(join(path, "bn")),
      },
      sharedFiles: Object.fromEntries(
        await Promise.all(
          ["metadata", "jwt", "validator-keys"].map(async (name) => [
            name,
            await fileInventory(join(path, "shared", name)),
          ]),
        ),
      ),
    };
    await store.write(source);
    const infra = new Infrastructure(store.id);
    // These are storage boundary tests; no synthetic client behavior is used as protocol evidence.
    infra.docker.listContainers = (() => Promise.resolve([])) as typeof infra.docker.listContainers;
    await run({ store, snapshots: new SnapshotStore(store, infra), bake, source });
  } finally {
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("snapshot capture publishes a separate immutable artifact and preserves its source", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const before = await fileInventory(store.generationPath(source.generation));
    const saved = await snapshots.capture(bake);
    assert.equal(saved.nowMs, source.checkpoint!.nowMs);
    assert.deepEqual(await snapshots.list(), [saved]);
    assert.deepEqual(await store.active(), source);
    assert.deepEqual(await fileInventory(store.generationPath(source.generation)), before);
    const manifest = await snapshots.read(saved.id, bake, source.config);
    assert.deepEqual(manifest.checkpoint, source.checkpoint);
    assert.equal(manifest.files["owner.json"], undefined);
    assert.equal(JSON.stringify(manifest).includes(store.root), false);
    await assert.rejects(snapshots.capture(bake, saved.id), /already exists/);
    await store.destroy(source);
    assert.equal(await store.active(), undefined);
    assert.deepEqual(await snapshots.read(saved.id, bake, source.config), manifest);
  });
});

Deno.test("snapshot read refuses missing or modified bytes and incompatible identities", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const saved = await snapshots.capture(bake);
    await assert.rejects(snapshots.read(saved.id, { ...bake, key: "00".repeat(32) }), /exact/);
    const images = structuredClone(bake.images);
    images.cl.platform = "linux/amd64";
    await assert.rejects(snapshots.read(saved.id, { ...bake, images }), /platform/);
    await assert.rejects(
      snapshots.read(saved.id, bake, {
        ...source.config,
        genesisTime: source.config.genesisTime + 12,
      }),
      /configuration|schedule/,
    );
    const file = join(await store.snapshotsDirectory(), saved.id, "data", "el", "database");
    await Deno.writeTextFile(file, "changed checkpoint");
    await assert.rejects(snapshots.read(saved.id), /integrity/);
    await Deno.remove(file);
    await assert.rejects(snapshots.read(saved.id), /integrity/);
    assert.deepEqual(await store.active(), source);
  });
});

Deno.test("snapshot integrity binds file permissions and the complete directory tree", async (t) => {
  for (
    const change of [
      "file mode",
      "directory mode",
      "removed empty directory",
      "added empty directory",
    ]
  ) {
    await t.step(change, async () => {
      await fixture(async ({ store, snapshots, bake, source }) => {
        await Deno.mkdir(join(store.generationPath(source.generation), "bn", "empty"));
        const saved = await snapshots.capture(bake);
        const data = join(await store.snapshotsDirectory(), saved.id, "data");
        if (change === "file mode") await Deno.chmod(join(data, "shared", "jwt", "fixture"), 0o644);
        if (change === "directory mode") await Deno.chmod(join(data, "shared"), 0o755);
        if (change === "removed empty directory") await Deno.remove(join(data, "bn", "empty"));
        if (change === "added empty directory") await Deno.mkdir(join(data, "bn", "unexpected"));
        await assert.rejects(snapshots.read(saved.id), /integrity/);
        assert.deepEqual(await store.active(), source);
      });
    });
  }
});

Deno.test("capture refuses unclean or changed checkpoint data without publishing a snapshot", async (t) => {
  for (const changed of ["running", "database", "keys", "transient"]) {
    await t.step(changed, async () => {
      await fixture(async ({ store, snapshots, bake, source }) => {
        const path = store.generationPath(source.generation);
        if (changed === "running") await store.write({ ...source, phase: "running" });
        if (changed === "database") {
          await Deno.writeTextFile(join(path, "el", "database"), "changed");
        }
        if (changed === "keys") {
          await Deno.writeTextFile(join(path, "shared", "validator-keys", "fixture"), "changed");
        }
        if (changed === "transient") await Deno.writeTextFile(join(path, "controller.pid"), "123");
        const active = await store.active();
        await assert.rejects(snapshots.capture(bake));
        assert.deepEqual(await snapshots.list(), []);
        assert.deepEqual(await store.active(), active);
      });
    });
  }
});

Deno.test("interrupted snapshot copying does not publish partial data or alter the source", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const before = await fileInventory(store.generationPath(source.generation));
    const copy = Deno.copyFile;
    Deno.copyFile = () => Promise.reject(new Error("injected disk full"));
    try {
      await assert.rejects(snapshots.capture(bake), /disk full/);
    } finally {
      Deno.copyFile = copy;
    }
    assert.deepEqual(await snapshots.list(), []);
    assert.deepEqual(await fileInventory(store.generationPath(source.generation)), before);
    assert.deepEqual(await store.active(), source);
  });
});

Deno.test("snapshot publication reads back data as well as metadata before advertising success", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const rename = Deno.rename;
    Deno.rename = async (from, to) => {
      await rename(from, to);
      if (String(to).includes(".pending-") && String(to).endsWith("/manifest.json")) {
        const data = String(to).replace(/manifest\.json$/, "data/bn/database");
        await Deno.writeTextFile(data, "corrupted after manifest write");
      }
    };
    try {
      await assert.rejects(snapshots.capture(bake), /integrity|changed|readback/i);
    } finally {
      Deno.rename = rename;
    }
    assert.deepEqual(await snapshots.list(), []);
    assert.deepEqual(await store.active(), source);
  });
});

Deno.test("snapshot IDs, ownership and symlinks cannot redirect artifact access", async () => {
  await fixture(async ({ store, snapshots, bake }) => {
    for (const id of ["..", "../../outside", "/tmp/outside", "not-a-uuid"]) {
      await assert.rejects(snapshots.read(id), /ID/);
    }
    const saved = await snapshots.capture(bake);
    const path = join(await store.snapshotsDirectory(), saved.id);
    await Deno.rename(path, `${path}-outside`);
    await Deno.symlink(`${path}-outside`, path);
    await assert.rejects(snapshots.read(saved.id), /Unsafe/);
  });
});

Deno.test("restore preparation copies into independent generations while the source remains live", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const saved = await snapshots.capture(bake);
    const artifact = await snapshots.read(saved.id);
    await store.write({ ...source, phase: "running" });
    const active = await store.active();
    const live = await StateLock.acquire(join(store.root, "network.lock"));
    try {
      const candidates = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const allocated: string[] = [];
        const candidate = await snapshots.prepare(saved.id, bake, source.config, async (value) => {
          allocated.push(value.generation);
          assert.deepEqual(await store.active(), active);
          assert.deepEqual(
            Object.keys(await fileInventory(store.generationPath(value.generation))),
            [
              "owner.json",
            ],
          );
        });
        candidates.push(candidate.generation);
        assert.deepEqual(allocated, [candidate.generation]);
        assert.equal(candidate.phase, "stopped");
        assert.deepEqual(candidate.checkpoint, source.checkpoint);
        const files = await fileInventory(await store.validate(candidate));
        delete files["owner.json"];
        assert.deepEqual(files, artifact.files);
        await Deno.writeTextFile(
          join(store.generationPath(candidate.generation), "el", "database"),
          "new branch",
        );
        assert.deepEqual(await snapshots.read(saved.id), artifact);
        assert.deepEqual(await store.active(), active);
      }
      assert.notEqual(candidates[0], candidates[1]);
      assert.equal(candidates.includes(source.generation), false);
    } finally {
      live.release();
    }
  });
});

Deno.test("restore preparation validates the entire artifact before allocating a candidate", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const saved = await snapshots.capture(bake);
    let allocations = 0;
    const allocated = () => {
      allocations++;
      return Promise.resolve();
    };
    await assert.rejects(
      snapshots.prepare(saved.id, { ...bake, key: "bad" }, source.config, allocated),
      /exact/,
    );
    const path = join(await store.snapshotsDirectory(), saved.id, "data", "bn", "database");
    await Deno.writeTextFile(path, "damaged");
    await assert.rejects(snapshots.prepare(saved.id, bake, source.config, allocated), /integrity/);
    assert.equal(allocations, 0);
    assert.deepEqual(await store.active(), source);
  });
});

Deno.test("failed restore preparation retains source and archive without publishing the partial candidate", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const saved = await snapshots.capture(bake);
    const artifact = await snapshots.read(saved.id);
    let allocated: string | undefined;
    const copy = Deno.copyFile;
    Deno.copyFile = () => Promise.reject(new Error("injected restore disk full"));
    try {
      await assert.rejects(
        snapshots.prepare(saved.id, bake, source.config, (value) => {
          allocated = value.generation;
          return Promise.resolve();
        }),
        /restore disk full/,
      );
    } finally {
      Deno.copyFile = copy;
    }
    assert.ok(allocated);
    assert.notEqual(allocated, source.generation);
    assert.deepEqual(await store.active(), source);
    assert.deepEqual(await snapshots.read(saved.id), artifact);
  });
});

Deno.test("snapshot removal only deletes its artifact, even when its data is damaged", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const saved = await snapshots.capture(bake);
    const other = await snapshots.capture(bake);
    const before = await fileInventory(store.generationPath(source.generation));
    await Deno.remove(join(await store.snapshotsDirectory(), saved.id, "data"), {
      recursive: true,
    });
    assert.deepEqual(await snapshots.remove(saved.id), saved);
    assert.deepEqual(await snapshots.list(), [other]);
    await assert.rejects(snapshots.read(saved.id), /removed/);
    await assert.rejects(snapshots.capture(bake, saved.id), /removed|immutable/);
    assert.deepEqual(await snapshots.remove(saved.id), saved);
    assert.deepEqual(await store.active(), source);
    assert.deepEqual(await fileInventory(store.generationPath(source.generation)), before);
    await snapshots.read(other.id);
    await assert.rejects(snapshots.remove(crypto.randomUUID()), Deno.errors.NotFound);
    await assert.rejects(snapshots.remove("../outside"), /ID/);
  });
});

Deno.test("interrupted removal finishes without restoring a partially deleted archive", async (t) => {
  for (const cut of ["intent", "rename", "partial unlink", "unlink acknowledgement"]) {
    await t.step(cut, async () => {
      await fixture(async ({ store, snapshots, bake, source }) => {
        const saved = await snapshots.capture(bake);
        const parent = await store.snapshotsDirectory();
        const tombstone = join(parent, `.removing-${saved.id}`);
        const rename = Deno.rename;
        const remove = Deno.remove;
        Deno.rename = async (from, to) => {
          await rename(from, to);
          if (
            (cut === "intent" && String(to) === join(parent, `.removed-${saved.id}.json`)) ||
            (cut === "rename" && String(to) === tombstone)
          ) throw new Error("injected interruption");
        };
        Deno.remove = async (path, options) => {
          if (String(path) === tombstone) {
            if (cut === "partial unlink") {
              await remove(join(tombstone, "manifest.json"));
              throw new Error("injected interruption");
            }
            await remove(path, options);
            if (cut === "unlink acknowledgement") throw new Error("injected interruption");
            return;
          }
          await remove(path, options);
        };
        try {
          await assert.rejects(snapshots.remove(saved.id), /interruption/);
        } finally {
          Deno.rename = rename;
          Deno.remove = remove;
        }
        assert.deepEqual(await snapshots.list(), []);
        await assert.rejects(snapshots.read(saved.id), /removed/);
        assert.deepEqual(await snapshots.remove(saved.id), saved);
        await assert.rejects(Deno.lstat(tombstone), Deno.errors.NotFound);
        await assert.rejects(Deno.lstat(join(parent, saved.id)), Deno.errors.NotFound);
        assert.deepEqual(await store.active(), source);
      });
    });
  }
});

Deno.test("removal refuses an in-use archive and symlinked deletion paths", async () => {
  await fixture(async ({ store, snapshots, bake }) => {
    const saved = await snapshots.capture(bake);
    const lock = await StateLock.acquire(join(store.root, "snapshots.lock"));
    try {
      await assert.rejects(snapshots.remove(saved.id), /owned by live process/);
    } finally {
      lock.release();
    }
    await snapshots.read(saved.id);
    const path = join(await store.snapshotsDirectory(), saved.id);
    await Deno.rename(path, `${path}-outside`);
    await Deno.symlink(`${path}-outside`, path);
    await assert.rejects(snapshots.remove(saved.id), /Unsafe/);
    assert.ok(await Deno.stat(join(`${path}-outside`, "manifest.json")));
  });
});
