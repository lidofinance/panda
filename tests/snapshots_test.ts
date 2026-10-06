import assert from "node:assert/strict";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.ts";
import { Infrastructure } from "../src/docker.ts";
import { canonical, readBake } from "../src/profiles.ts";
import { type SnapshotManifest, SnapshotStore } from "../src/snapshots.ts";
import { saveSnapshotStream, snapshotSource } from "../src/snapshot_archive.ts";
import { SnapshotJournal } from "../src/snapshot_operations.ts";
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
    const bake = await readBake("gloas", "snapshot-minimal-r1");
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
    source.phase = "stopped";
    source.checkpoint = {
      schema: 2,
      slot: 3,
      nowMs: config.genesisTime * 1000 + 47_500,
      headSlot: 3,
      headBlockRoot: `0x${"12".repeat(32)}`,
      headStateRoot: `0x${"34".repeat(32)}`,
      executionBlockHash: `0x${"56".repeat(32)}`,
      executionBlockNumber: 3,
      finalizedEpoch: 0,
      finalizedRoot: `0x${"00".repeat(32)}`,
      replayMessages: [],
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
      ) as NonNullable<typeof source.checkpoint>["sharedFiles"],
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

Deno.test("portable snapshots rebind ownership and preserve bytes, keys and checkpoint", async () => {
  await fixture(async ({ store, snapshots, bake }) => {
    const saved = await snapshots.capture(bake);
    const original = await snapshots.read(saved.id);
    const exported = await snapshots.export(saved.id);
    try {
      const target = new StateStore("imported-owner");
      const imported = new SnapshotStore(target, new Infrastructure(target.id));
      const ref = await imported.import(exported.path, { sha256: exported.sha256 });
      const manifest = await imported.read(ref.id, bake);
      assert.equal(manifest.owner, target.id);
      assert.equal(manifest.config.id, target.id);
      assert.equal(JSON.stringify(manifest.config), JSON.stringify(configuration(manifest.config)));
      assert.deepEqual(manifest.files, original.files);
      assert.deepEqual(manifest.checkpoint, original.checkpoint);
      assert.deepEqual(manifest.images, original.images);
      assert.equal(await target.active(), undefined);
      assert.deepEqual(await imported.import(exported.path), ref, "same file is idempotent");
      assert.deepEqual(
        await snapshots.read(saved.id),
        original,
        "export/import mutated the source",
      );
      assert.equal((await imported.list()).length, 1);
      const decoded = await new Response(
        new Blob([await Deno.readFile(exported.path)]).stream().pipeThrough(
          new DecompressionStream("gzip"),
        ),
      ).arrayBuffer();
      assert(
        !new TextDecoder().decode(decoded).includes(store.id),
        "source owner leaked into archive",
      );
      await imported.remove(ref.id);
      await assert.rejects(imported.import(exported.path), /removed/);
      assert.deepEqual(await snapshots.read(saved.id), original);
    } finally {
      await exported.cleanup();
    }
  });
});

async function changeArchive(
  source: string,
  output: string,
  change: (header: SnapshotManifest & { format: string }) => void,
  payload: (bytes: Uint8Array) => Uint8Array = (bytes) => bytes,
  serialize: (header: unknown) => string = canonical,
) {
  const decoded = new Uint8Array(
    await new Response(
      new Blob([await Deno.readFile(source)]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const start = new TextEncoder().encode("PANDA_SNAPSHOT_V2\n").length;
  const size = new DataView(decoded.buffer).getUint32(start);
  const header = JSON.parse(
    new TextDecoder().decode(decoded.subarray(start + 4, start + 4 + size)),
  );
  change(header);
  const json = new TextEncoder().encode(serialize(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.length);
  await Deno.writeFile(
    output,
    new Uint8Array(
      await new Response(
        new Blob([
          decoded.slice(0, start),
          length,
          json,
          new Uint8Array(payload(decoded.slice(start + 4 + size))),
        ])
          .stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    ),
  );
}

Deno.test("external snapshot rejection leaves no published or pending artifact", async (t) => {
  await fixture(async ({ store, snapshots, bake }) => {
    const saved = await snapshots.capture(bake);
    const exported = await snapshots.export(saved.id);
    const target = new StateStore("invalid-import");
    const imported = new SnapshotStore(target, new Infrastructure(target.id));
    const changed = join(store.root, "changed.gz");
    const cases: [string, (header: SnapshotManifest & { format: string }) => void][] = [
      ["traversal", (h) => {
        h.metadata["el/../../escaped"] = h.metadata["el/database"];
      }],
      ["absolute", (h) => {
        h.metadata["/el/database"] = h.metadata["el/database"];
      }],
      ["backslash", (h) => {
        h.metadata["el\\escaped"] = h.metadata["el/database"];
      }],
      ["symlink", (h) => {
        Object.assign(h.metadata.el, { type: "symlink" });
      }],
      ["special permissions", (h) => {
        h.metadata.el.mode = 0o4777;
      }],
      ["missing directory", (h) => {
        delete h.metadata.el;
      }],
      ["negative size", (h) => {
        h.files["el/database"].size = -1;
      }],
      ["unsafe size", (h) => {
        h.files["el/database"].size = Number.MAX_SAFE_INTEGER;
      }],
      ["hash", (h) => {
        h.files["el/database"].hash = "ab".repeat(32);
      }],
      ["database inventory", (h) => {
        Object.assign(h.checkpoint, { databaseFiles: {} });
      }],
      ["key inventory", (h) => {
        Object.assign(h.checkpoint, { sharedFiles: {} });
      }],
      ["image", (h) => {
        h.images.cl.id = `sha256:${"00".repeat(32)}`;
      }],
      ["platform", (h) => {
        h.images.cl.platform = "linux/other";
      }],
      ["legacy native schema", (h) => {
        Object.assign(h.checkpoint, { schema: 1, abi: 1 });
      }],
      ["invalid replay bytes", (h) => {
        h.checkpoint.replayMessages = [{
          path: "/eth/v1/beacon/pool/sync_committees",
          headers: [["content-type", "application/json"]],
          body: [256],
        }];
      }],
      ["future replay message", (h) => {
        h.checkpoint.replayMessages = [{
          path: "/eth/v1/beacon/pool/sync_committees",
          headers: [["content-type", "application/json"]],
          body: [...new TextEncoder().encode(
            JSON.stringify([{
              slot: "4",
              validator_index: "0",
              beacon_block_root: `0x${"00".repeat(32)}`,
              signature: `0x${"00".repeat(96)}`,
            }]),
          )],
        }];
      }],
      ["head slot", (h) => {
        h.checkpoint.headSlot = h.snapshot.headSlot = 1234;
      }],
      ["unknown config", (h) => {
        Object.assign(h.config, { directory: "/outside" });
      }],
      ["numeric creation time", (h) => {
        Object.assign(h.snapshot, { createdAt: 123 });
      }],
      ["unknown snapshot field", (h) => {
        Object.assign(h.snapshot, { label: "untrusted" });
      }],
      ["format", (h) => {
        h.format = "tar";
      }],
    ];
    try {
      for (const [name, mutate] of cases) {
        await t.step(name, async () => {
          await changeArchive(exported.path, changed, mutate);
          await assert.rejects(imported.import(changed));
          assert.deepEqual(await imported.list(), []);
          assert.deepEqual(
            await Array.fromAsync(Deno.readDir(await target.snapshotsDirectory())),
            [],
          );
        });
      }
      for (
        const [name, mutate] of [
          ["truncated", (bytes: Uint8Array) => bytes.slice(0, -1)],
          ["trailing", (bytes: Uint8Array) => new Uint8Array([...bytes, 0])],
          ["corrupt", (bytes: Uint8Array) => new Uint8Array(bytes).fill(0, 0, 1)],
        ] as const
      ) {
        await t.step(name, async () => {
          await changeArchive(exported.path, changed, () => {}, mutate);
          await assert.rejects(imported.import(changed));
        });
      }
      await assert.rejects(imported.import(exported.path, { sha256: "00".repeat(32) }), /SHA-256/);
      await assert.rejects(imported.import(exported.path, { maxBytes: 20 }), /byte limit/);
      await assert.rejects(
        imported.import(exported.path, { maxBytes: exported.bytes + 1 }),
        /Uncompressed snapshot exceeds/,
      );
      await changeArchive(
        exported.path,
        changed,
        () => {},
        undefined,
        (header) =>
          canonical(header).replace(
            '"format":"panda-snapshot"',
            '"format":"panda-snapshot","format":"panda-snapshot"',
          ),
      );
      await assert.rejects(imported.import(changed), /duplicate keys/);
      await assert.rejects(imported.import(exported.path, { bake: "../bad" }));
      await assert.rejects(imported.import(exported.path, { signal: AbortSignal.abort() }));
      const link = join(store.root, "link.gz");
      await Deno.symlink(exported.path, link);
      await assert.rejects(imported.import(link), /regular file/);
      await assert.rejects(imported.import("http://example.org/snapshot.gz"), /HTTPS/);
      assert.deepEqual(await imported.list(), []);
      assert.deepEqual(await Array.fromAsync(Deno.readDir(await target.snapshotsDirectory())), []);
      assert.equal(await target.active(), undefined);
    } finally {
      await exported.cleanup();
    }
  });
});

Deno.test("external snapshot can use an installed equivalent bake with a different tag", async () => {
  await fixture(async ({ snapshots, store, bake }) => {
    const saved = await snapshots.capture(bake);
    const exported = await snapshots.export(saved.id);
    const cwd = Deno.cwd();
    try {
      const repository = join(store.root, "alias-repo");
      await Deno.mkdir(join(repository, "bakes/gloas/tags"), { recursive: true });
      await Deno.writeTextFile(
        join(repository, "bakes/gloas/tags/local-alias.json"),
        JSON.stringify({ ...bake, tag: "local-alias" }),
      );
      Deno.chdir(repository);
      for (const tag of [undefined, "local-alias"]) {
        const target = new StateStore(tag ? "explicit-alias" : "automatic-alias");
        const imported = new SnapshotStore(target, new Infrastructure(target.id));
        const ref = await imported.import(exported.path, { bake: tag });
        const result = await imported.read(ref.id);
        assert.equal(result.config.bake, "local-alias");
        assert.equal(result.snapshot.bakeKey, bake.key);
      }
    } finally {
      Deno.chdir(cwd);
      await exported.cleanup();
    }
  });
});

Deno.test("snapshot download follows bounded HTTPS redirects and refuses HTML or downgrade", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  let response = new Response("archive");
  globalThis.fetch = (input) => {
    seen.push(String(input));
    if (seen.length === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://assets.example.org/snapshot.gz" },
        }),
      );
    }
    return Promise.resolve(response);
  };
  try {
    assert.equal(
      await new Response(
        await snapshotSource(
          "https://github.com/org/repo/releases/download/v1/fixture.gz",
          AbortSignal.timeout(5000),
        ),
      ).text(),
      "archive",
    );
    assert.equal(seen.length, 2);
    response = new Response(null, {
      status: 302,
      headers: { location: "http://example.org/file" },
    });
    await assert.rejects(
      snapshotSource("https://example.org/file", AbortSignal.timeout(5000)),
      /HTTPS/,
    );
    response = new Response(null, { status: 302, headers: { location: "/again" } });
    await assert.rejects(
      snapshotSource("https://example.org/file", AbortSignal.timeout(5000)),
      /Too many/,
    );
    response = new Response("<html>", { headers: { "content-type": "text/html" } });
    await assert.rejects(
      snapshotSource("https://example.org/blob/fixture", AbortSignal.timeout(5000)),
      /raw file/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("canceling an HTTPS import releases the body, lock and partial artifact", async () => {
  await fixture(async () => {
    const original = globalThis.fetch;
    const read = Promise.withResolvers<void>();
    const abort = new AbortController();
    let canceled = false;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              read.resolve();
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
      );
    const store = new StateStore("canceled-import");
    const snapshots = new SnapshotStore(store, new Infrastructure(store.id));
    try {
      const work = assert.rejects(
        snapshots.import("https://example.org/fixture.gz", { signal: abort.signal }),
      );
      await read.promise;
      abort.abort();
      await work;
      assert(canceled);
      assert.equal(await store.active(), undefined);
      assert.deepEqual(await snapshots.list(), []);
      assert.deepEqual(await Array.fromAsync(Deno.readDir(await store.snapshotsDirectory())), []);
      const lock = await StateLock.acquire(join(store.root, "snapshots.lock"));
      lock.release();
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("snapshot file output never replaces existing files and cleans canceled writes", async () => {
  const base = await Deno.makeTempDir();
  const path = join(base, "snapshot.gz");
  try {
    await Deno.writeTextFile(path, "keep");
    await assert.rejects(saveSnapshotStream(new Blob(["new"]).stream(), path));
    assert.equal(await Deno.readTextFile(path), "keep");
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    await assert.rejects(
      saveSnapshotStream(stream, join(base, "cancel.gz"), { signal: AbortSignal.abort() }),
    );
    assert(canceled);
    assert.equal((await Array.fromAsync(Deno.readDir(base))).length, 1);
    for (const options of [{ maxBytes: 0 }, { sha256: "bad" }]) {
      let released = false;
      const input = new ReadableStream<Uint8Array>({
        cancel() {
          released = true;
        },
      });
      await assert.rejects(saveSnapshotStream(input, join(base, "invalid.gz"), options));
      assert(released, "invalid options must release the input stream");
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

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
          await assert.rejects(
            Deno.stat(store.generationPath(value.generation)),
            Deno.errors.NotFound,
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

Deno.test("restore refuses insufficient capacity before allocating or stopping its source", async () => {
  await fixture(async ({ store, snapshots, bake, source }) => {
    const saved = await snapshots.capture(bake);
    const read = snapshots.read.bind(snapshots);
    const manifest = await read(saved.id);
    const disk = await statfs(store.root);
    // Isolate the capacity boundary after actual archive validation without filling the host disk.
    snapshots.read = async (...args) => {
      const verified = await read(...args);
      return {
        ...verified,
        files: {
          ...verified.files,
          "el/database": { ...verified.files["el/database"], size: disk.blocks * disk.bsize + 1 },
        },
      };
    };
    let allocations = 0;
    await store.write({ ...source, phase: "running" });
    const active = await store.active();
    await assert.rejects(
      snapshots.prepare(saved.id, bake, source.config, () => {
        allocations++;
        return Promise.resolve();
      }),
      /Insufficient free space/,
    );
    assert.equal(allocations, 0);
    assert.deepEqual(await store.active(), active);
    assert.deepEqual(await read(saved.id), manifest);
    const lock = await StateLock.acquire(join(store.root, "snapshots.lock"));
    lock.release();
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

Deno.test("portable snapshots preserve sparse tails without requiring the head at the clock slot", async () => {
  await fixture(async ({ snapshots, store, bake, source }) => {
    source.checkpoint = {
      ...source.checkpoint!,
      slot: 35,
      headSlot: 2,
      nowMs: source.config.genesisTime * 1000 + 35 * 12000 + 11500,
    };
    await store.write(source);
    const saved = await snapshots.capture(bake);
    const exported = await snapshots.export(saved.id);
    try {
      const target = new StateStore("sparse-import");
      const imported = new SnapshotStore(target, new Infrastructure(target.id));
      const ref = await imported.import(exported.path);
      assert.deepEqual((await imported.read(ref.id)).checkpoint, source.checkpoint);
    } finally {
      await exported.cleanup();
    }
  });
});

Deno.test("HTTPS import requests raw bytes and refuses transparently decoded bodies", async () => {
  const original = globalThis.fetch;
  const requested: (string | null)[] = [];
  let encoding: string | undefined;
  globalThis.fetch = (_input, init) => {
    requested.push(new Headers(init?.headers).get("accept-encoding"));
    return Promise.resolve(
      new Response("archive", { headers: encoding ? { "content-encoding": encoding } : {} }),
    );
  };
  try {
    const signal = AbortSignal.timeout(5000);
    assert.equal(
      await new Response(await snapshotSource("https://example.org/a.gz", signal)).text(),
      "archive",
    );
    assert.deepEqual(requested, ["identity"], "the host may compress or decode the archive");
    encoding = "gzip";
    await assert.rejects(snapshotSource("https://example.org/a.gz", signal), /Content-Encoding/);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("listing ignores foreign and damaged entries instead of failing for the owner", async () => {
  await fixture(async ({ store, snapshots, bake }) => {
    const kept = await snapshots.capture(bake);
    const directory = await store.snapshotsDirectory();
    await Deno.writeTextFile(join(directory, ".DS_Store"), "finder");
    await Deno.mkdir(join(directory, "notes"));
    const damaged = crypto.randomUUID();
    await Deno.mkdir(join(directory, damaged));
    await Deno.writeTextFile(join(directory, damaged, "manifest.json"), "{");
    assert.deepEqual((await snapshots.list()).map((value) => value.id), [kept.id]);
  });
});

Deno.test("ownership startup removes abandoned import and export copies only", async () => {
  await fixture(async ({ store, snapshots, bake }) => {
    const kept = await snapshots.capture(bake);
    const directory = await store.snapshotsDirectory();
    const capture = `.pending-${crypto.randomUUID()}`;
    for (const name of [".pending-export-abc", ".pending-import-def", capture]) {
      await Deno.mkdir(join(directory, name));
      await Deno.writeTextFile(join(directory, name, "keys"), "validator secrets");
    }
    await snapshots.sweepTransfers();
    const names = [];
    for await (const entry of Deno.readDir(directory)) names.push(entry.name);
    assert.deepEqual(names.sort(), [capture, kept.id].sort(), "journal-owned capture was touched");
  });
});

Deno.test("foreign store entries never block startup sweeps or operation listing", async () => {
  await fixture(async ({ store, snapshots }) => {
    const directory = await store.snapshotsDirectory();
    await Deno.writeTextFile(join(directory, ".pending-export-file"), "not a directory");
    await snapshots.sweepTransfers();
    await Deno.lstat(join(directory, ".pending-export-file"));
    const journal = new SnapshotJournal(store);
    await journal.list();
    const operations = join(store.root, "operations");
    await Deno.mkdir(operations, { recursive: true });
    await Deno.writeTextFile(join(operations, ".DS_Store"), "finder");
    assert.deepEqual(await journal.list(), []);
  });
});
