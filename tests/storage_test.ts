import assert from "node:assert/strict";
import { join } from "node:path";
import { configuration } from "../src/config.ts";
import { Network } from "../src/network.ts";
import {
  type ActiveGeneration,
  type Checkpoint,
  fileInventory,
  StateLock,
  StateStore,
  type StoredPhase,
} from "../src/storage.ts";

const owner = "storage-owner";
const bakeKey = "ab".repeat(32);
const checkpoint: Checkpoint = {
  abi: 1,
  nowMs: 2_000_000_047_500,
  headSlot: 3,
  headBlockRoot: `0x${"12".repeat(32)}`,
  headStateRoot: `0x${"34".repeat(32)}`,
  forkChoiceSlot: 4,
  checkpointHash: `0x${"56".repeat(32)}`,
};

async function fixture(run: (store: StateStore, base: string) => Promise<void>) {
  const base = await Deno.makeTempDir({ prefix: "panda-storage-test-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  try {
    await run(new StateStore(owner), base);
  } finally {
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

async function create(store: StateStore) {
  return await store.create(configuration({ id: store.id }), bakeKey);
}

async function stopped(store: StateStore) {
  const value = await create(store);
  value.phase = "stopped";
  value.checkpoint = structuredClone(checkpoint);
  await store.write(value);
  return value;
}

async function put(path: string, value: unknown) {
  await Deno.writeTextFile(path, JSON.stringify(value));
}

Deno.test("storage opens only a preserved generation and never creates one during resume", async () => {
  await fixture(async (store) => {
    assert.equal(await store.active(), undefined);
    await assert.rejects(store.resumable(), /No preserved active generation/);
    await assert.rejects(Deno.stat(store.root), Deno.errors.NotFound);
    const value = await stopped(store);
    const database = join(store.generationPath(value.generation), "bn", "database-evidence");
    await Deno.writeTextFile(database, "existing consensus data");
    const reopened = new StateStore(store.id);
    assert.deepEqual(await reopened.resumable(), value);
    assert.equal(await Deno.readTextFile(database), "existing consensus data");
    await assert.rejects(create(reopened), /Active generation exists/);
    assert.deepEqual(await reopened.active(), value);
  });
});

Deno.test("storage refuses every unclean phase even when an earlier checkpoint remains", async () => {
  await fixture(async (store) => {
    const value = await stopped(store);
    for (const phase of ["starting", "running", "stopping", "faulted"] as StoredPhase[]) {
      await store.write({ ...value, phase });
      await assert.rejects(store.resumable(), /unclean/, phase);
    }
    await store.write({ ...value, checkpoint: undefined });
    await assert.rejects(store.resumable(), /checkpoint/);
  });
});

Deno.test("storage refuses incomplete or malformed checkpoint metadata before resume", async (t) => {
  for (
    const [name, invalid] of [
      ["ABI only", { abi: 1 }],
      ["unsupported ABI", { ...checkpoint, abi: 2 }],
      ["negative time", { ...checkpoint, nowMs: -1 }],
      ["fractional slot", { ...checkpoint, headSlot: 3.5 }],
      ["missing fork-choice time", { ...checkpoint, forkChoiceSlot: undefined }],
      ["invalid block root", { ...checkpoint, headBlockRoot: "not-a-root" }],
      ["missing state root", { ...checkpoint, headStateRoot: undefined }],
      ["missing checkpoint integrity", { ...checkpoint, checkpointHash: undefined }],
    ] as const
  ) {
    await t.step(name, async () => {
      await fixture(async (store) => {
        const value = await stopped(store);
        // Simulate an incomplete/interrupted or corrupted durable record, not a typed caller.
        await put(join(store.root, "active.json"), { ...value, checkpoint: invalid });
        await assert.rejects(store.resumable());
      });
    });
  }
});

Deno.test("storage rejects another owner's active record and never deletes its data", async () => {
  await fixture(async (store) => {
    const value = await stopped(store);
    const original = await Deno.readTextFile(join(store.root, "active.json"));
    for (
      const invalid of [
        { ...value, id: "another-owner" },
        { ...value, config: { ...value.config, id: "another-owner" } },
        { ...value, schema: 2 },
      ]
    ) {
      await put(join(store.root, "active.json"), invalid);
      await assert.rejects(store.active(), /ownership|schema/i);
      await assert.rejects(store.destroy(value), /ownership|schema/i);
      assert((await Deno.stat(store.generationPath(value.generation))).isDirectory);
    }
    await Deno.writeTextFile(join(store.root, "active.json"), original);
    assert.deepEqual(await store.resumable(), value);
  });
});

Deno.test("storage validates root ownership again before opening or destroying data", async (t) => {
  for (
    const [name, marker] of [
      ["wrong owner", { schema: 1, id: "another-owner" }],
      ["unknown schema", { schema: 2, id: owner }],
      ["missing marker", undefined],
      ["corrupt marker", "{"],
    ] as const
  ) {
    await t.step(name, async () => {
      await fixture(async (store) => {
        const value = await stopped(store);
        const path = join(store.root, "owner.json");
        if (marker === undefined) await Deno.remove(path);
        else if (typeof marker === "string") await Deno.writeTextFile(path, marker);
        else await put(path, marker);
        await assert.rejects(store.resumable());
        await assert.rejects(store.destroy(value));
        assert((await Deno.stat(store.generationPath(value.generation))).isDirectory);
      });
    });
  }
});

Deno.test("storage does not adopt existing data whose ownership marker disappeared", async () => {
  await fixture(async (store) => {
    const value = await stopped(store);
    const marker = join(store.root, "owner.json");
    await Deno.remove(marker);
    await assert.rejects(new StateStore(store.id).initialize());
    await assert.rejects(Deno.stat(marker), Deno.errors.NotFound);
    assert((await Deno.stat(store.generationPath(value.generation))).isDirectory);
  });
});

Deno.test("storage rejects missing or corrupt generation ownership markers", async (t) => {
  for (const marker of [undefined, "{", JSON.stringify({ schema: 1, id: owner })]) {
    await t.step(marker === undefined ? "missing" : marker, async () => {
      await fixture(async (store) => {
        const value = await stopped(store);
        const path = join(store.generationPath(value.generation), "owner.json");
        if (marker === undefined) await Deno.remove(path);
        else await Deno.writeTextFile(path, marker);
        await assert.rejects(store.resumable());
        await assert.rejects(store.destroy(value));
      });
    });
  }
});

Deno.test("storage rejects traversal in owner and generation names", async () => {
  await fixture(async (store) => {
    for (const id of ["../another", "/tmp/another", "owner/another", ".", ""]) {
      assert.throws(() => new StateStore(id), /Invalid devnet id/);
    }
    const value = await stopped(store);
    for (const generation of ["../snapshots", "/tmp/another", `${value.generation}/../other`]) {
      assert.throws(() => store.generationPath(generation), /Invalid generation ID/);
      await put(join(store.root, "active.json"), { ...value, generation });
      await assert.rejects(store.active(), /Invalid generation ID/);
    }
  });
});

Deno.test("storage rejects symlinked state directories without touching the target", async (t) => {
  for (const component of ["root", "generations", "generation", "el", "bn", "shared"]) {
    await t.step(component, async () => {
      await fixture(async (store, base) => {
        const value = await stopped(store);
        const generation = store.generationPath(value.generation);
        const path = component === "root"
          ? store.root
          : component === "generations"
          ? join(store.root, "generations")
          : component === "generation"
          ? generation
          : join(generation, component);
        const target = join(base, "outside-owned-tree");
        await Deno.rename(path, target);
        await Deno.symlink(target, path);
        const sentinel = join(target, "must-survive");
        await Deno.writeTextFile(sentinel, "untouched");
        await assert.rejects(store.resumable(), /Unsafe state directory/);
        await assert.rejects(store.destroy(value), /Unsafe state directory/);
        assert.equal(await Deno.readTextFile(sentinel), "untouched");
      });
    });
  }
});

Deno.test("storage rejects symlinked active and ownership records", async (t) => {
  for (const name of ["active", "root owner", "generation owner"]) {
    await t.step(name, async () => {
      await fixture(async (store, base) => {
        const value = await stopped(store);
        const path = name === "active"
          ? join(store.root, "active.json")
          : name === "root owner"
          ? join(store.root, "owner.json")
          : join(store.generationPath(value.generation), "owner.json");
        const target = join(base, "external-record.json");
        await Deno.rename(path, target);
        await Deno.symlink(target, path);
        const original = await Deno.readTextFile(target);
        await assert.rejects(store.resumable(), /Unsafe state file/);
        await assert.rejects(store.destroy(value), /Unsafe state file/);
        assert.equal(await Deno.readTextFile(target), original);
      });
    });
  }
});

Deno.test("destroy removes only the active generation and preserves snapshots and other owners", async () => {
  await fixture(async (store) => {
    const value = await stopped(store);
    const other = new StateStore("unrelated-owner");
    const otherValue = await stopped(other);
    const inactive = store.generationPath(crypto.randomUUID());
    await Deno.mkdir(inactive);
    const paths = [
      join(store.root, "snapshots", "snapshot-evidence"),
      join(inactive, "retained-generation-evidence"),
      join(other.generationPath(otherValue.generation), "el", "unrelated-database"),
    ];
    for (const path of paths) await Deno.writeTextFile(path, path);
    await store.destroy(value);
    assert.equal(await store.active(), undefined);
    await assert.rejects(Deno.stat(store.generationPath(value.generation)), Deno.errors.NotFound);
    for (const path of paths) assert.equal(await Deno.readTextFile(path), path);
    assert.deepEqual(await other.resumable(), otherValue);
    const replacement = await create(store);
    assert.notEqual(replacement.generation, value.generation);
    for (const path of paths) assert.equal(await Deno.readTextFile(path), path);
  });
});

Deno.test("destroy refuses a stale generation handle after active pointer replacement", async () => {
  await fixture(async (store) => {
    const old = await stopped(store);
    await Deno.remove(join(store.root, "active.json"));
    const current = await create(store);
    await assert.rejects(store.destroy(old), /Active generation changed/);
    assert.deepEqual(await store.active(), current);
    assert((await Deno.stat(store.generationPath(old.generation))).isDirectory);
    assert((await Deno.stat(store.generationPath(current.generation))).isDirectory);
  });
});

Deno.test("storage refuses corrupt active JSON and unknown lifecycle phases", async () => {
  await fixture(async (store) => {
    const value = await stopped(store);
    const path = join(store.root, "active.json");
    await Deno.writeTextFile(path, "{");
    await assert.rejects(store.active(), SyntaxError);
    await put(path, { ...value, phase: "almost-stopped" } as unknown as ActiveGeneration);
    await assert.rejects(store.active(), /Invalid stored lifecycle phase/);
  });
});

Deno.test("one stable ownership lock wins concurrent starts and survives release without unlinking", async () => {
  await fixture(async (store) => {
    await store.initialize();
    const path = join(store.root, "network.lock");
    // Stale PID text is diagnostic only; it must not cause competing unlink/recreate operations.
    await Deno.writeTextFile(path, "2147483647");
    const before = await Deno.stat(path);
    const attempts = await Promise.allSettled([StateLock.acquire(path), StateLock.acquire(path)]);
    const held = attempts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    try {
      assert.equal(held.length, 1);
      assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
      await assert.rejects(StateLock.acquire(path), /owned by live process/);
      assert.equal((await Deno.stat(path)).ino, before.ino);
    } finally {
      for (const lock of held) lock.release();
    }
    const next = await StateLock.acquire(path);
    next.release();
    assert.equal((await Deno.stat(path)).ino, before.ino);
  });
});

Deno.test("an owner process crash releases the OS lock while its PID file remains", async () => {
  await fixture(async (store) => {
    await store.initialize();
    const path = join(store.root, "network.lock");
    const module = new URL("../src/storage.ts", import.meta.url).href;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { StateLock } from ${JSON.stringify(module)};\n` +
        `await StateLock.acquire(${JSON.stringify(path)});\n` +
        'console.log("locked");\nsetInterval(() => {}, 1000);',
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let exited = false;
    const exit = child.status.then((status) => {
      exited = true;
      return status;
    });
    const output = child.stdout.getReader();
    const errors = new Response(child.stderr).text();
    try {
      assert.match(new TextDecoder().decode((await output.read()).value), /locked/);
      await assert.rejects(StateLock.acquire(path), /owned by live process/);
      child.kill("SIGKILL");
      const status = await exit;
      assert.equal(status.success, false);
      assert.equal(await Deno.readTextFile(path), String(child.pid));
      const recovered = await StateLock.acquire(path);
      recovered.release();
    } finally {
      if (!exited) child.kill("SIGKILL");
      await exit;
      await output.cancel();
      output.releaseLock();
      await errors;
    }
  });
});

Deno.test("destructive fallback stop cannot act while another controller owns the generation", async () => {
  await fixture(async (store) => {
    const value = await stopped(store);
    const lock = await StateLock.acquire(join(store.root, "network.lock"));
    try {
      // The real entrypoint must reject before reaching any Docker operation.
      const network = new Network(value.config);
      let reachedDocker = false;
      network.infra.cleanup = () => {
        reachedDocker = true;
        return Promise.resolve();
      };
      network.saveLogs = () => {
        reachedDocker = true;
        return Promise.resolve();
      };
      await assert.rejects(network.stop(), /owned by live process/);
      assert.equal(reachedDocker, false);
      assert.deepEqual(await store.active(), value);
    } finally {
      lock.release();
    }
  });
});

Deno.test("ownership locks reject symlinks without overwriting their target", async () => {
  await fixture(async (store, base) => {
    await store.initialize();
    const target = join(base, "foreign-file");
    await Deno.writeTextFile(target, "foreign data");
    const lockPath = join(store.root, "network.lock");
    await Deno.symlink(target, lockPath);
    await assert.rejects(StateLock.acquire(lockPath), /Unsafe ownership lock/);
    assert.equal(await Deno.readTextFile(target), "foreign data");
  });
});

Deno.test("file inventory detects changed contents, deleted definitions and renamed keys", async () => {
  await fixture(async (store) => {
    const value = await stopped(store);
    const shared = join(store.generationPath(value.generation), "shared");
    const keys = join(shared, "validator-keys", "keys");
    await Deno.mkdir(keys, { recursive: true });
    const definition = join(keys, "validator_definitions.yml");
    const key = join(keys, "keystore.json");
    await Deno.writeTextFile(definition, "one local validator");
    await Deno.writeTextFile(key, "original key");
    const original = await fileInventory(shared);
    assert.deepEqual(Object.keys(original), [
      "validator-keys/keys/keystore.json",
      "validator-keys/keys/validator_definitions.yml",
    ]);
    assert.deepEqual(await fileInventory(shared), original);
    await Deno.writeTextFile(key, "modified key");
    assert.notDeepEqual(await fileInventory(shared), original);
    await Deno.writeTextFile(key, "original key");
    assert.deepEqual(await fileInventory(shared), original);
    await Deno.rename(key, join(keys, "other-keystore.json"));
    assert.notDeepEqual(await fileInventory(shared), original);
    await Deno.rename(join(keys, "other-keystore.json"), key);
    await Deno.remove(definition);
    assert.notDeepEqual(await fileInventory(shared), original);
  });
});

Deno.test("file inventory rejects symlink ancestors and leaf files rather than hashing external data", async (t) => {
  for (const component of ["root", "directory", "file"]) {
    await t.step(component, async () => {
      await fixture(async (_store, base) => {
        const root = join(base, "inventory");
        await Deno.mkdir(join(root, "keys"), { recursive: true });
        await Deno.writeTextFile(join(root, "keys", "keystore.json"), "owned key");
        const path = component === "root"
          ? root
          : component === "directory"
          ? join(root, "keys")
          : join(root, "keys", "keystore.json");
        const outside = join(base, "outside");
        await Deno.rename(path, outside);
        await Deno.symlink(outside, path);
        await assert.rejects(fileInventory(root), /Unsafe link/);
      });
    });
  }
});

Deno.test("generation directory entries are durable before active publication", async () => {
  await fixture(async (store) => {
    const open = Deno.open;
    const rename = Deno.rename;
    const synced = new Set<string>();
    Deno.open = async (path, options) => {
      const file = await open(path, options);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        await sync();
        synced.add(String(path));
      };
      return file;
    };
    Deno.rename = async (from, to) => {
      if (String(to) === join(store.root, "active.json")) {
        assert(
          synced.has(join(store.root, "generations")),
          "generation name was not made durable before active pointer",
        );
        assert(synced.has(join(store.root, "..")), "owner root name was not made durable");
      }
      await rename(from, to);
    };
    try {
      await create(store);
    } finally {
      Deno.open = open;
      Deno.rename = rename;
    }
  });
});

Deno.test("a generation-parent fsync failure cannot publish the new active pointer", async () => {
  await fixture(async (store) => {
    await store.initialize();
    const open = Deno.open;
    Deno.open = async (path, options) => {
      const file = await open(path, options);
      if (String(path) === join(store.root, "generations")) {
        file.sync = () => Promise.reject(new Error("injected directory fsync failure"));
      }
      return file;
    };
    try {
      await assert.rejects(create(store), /directory fsync failure/);
    } finally {
      Deno.open = open;
    }
    assert.equal(await store.active(), undefined);
  });
});
