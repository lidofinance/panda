import assert from "node:assert/strict";
import { join } from "node:path";
import { configuration } from "../src/config.ts";
import { GENERATION, Infrastructure, LABEL } from "../src/docker.ts";
import { type ActiveGeneration, fileInventory, StateLock, StateStore } from "../src/storage.ts";

async function fixture(
  run: (value: {
    store: StateStore;
    infra: Infrastructure;
    source: ActiveGeneration;
    destination: ActiveGeneration;
    base: string;
  }) => Promise<void>,
) {
  const base = await Deno.makeTempDir({ prefix: "panda-copy-test-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  try {
    const store = new StateStore("copy-owner");
    const config = configuration({ id: store.id });
    const source = await store.create(config, "ab".repeat(32));
    source.phase = "stopped";
    source.checkpoint = {
      abi: 1,
      nowMs: config.genesisTime * 1000 + 47_500,
      headSlot: 3,
      headBlockRoot: `0x${"12".repeat(32)}`,
      headStateRoot: `0x${"34".repeat(32)}`,
      forkChoiceSlot: 4,
      checkpointHash: `0x${"56".repeat(32)}`,
    };
    await store.write(source);
    const destination = await store.allocate(config, source.bakeKey);
    const infra = new Infrastructure(store.id);
    infra.docker.listContainers = (() => Promise.resolve([])) as typeof infra.docker.listContainers;
    await run({ store, infra, source, destination, base });
  } finally {
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("allocate and copy leave the active pointer unchanged and preserve bytes and file metadata", async () => {
  await fixture(async ({ store, infra, source, destination }) => {
    const from = store.generationPath(source.generation);
    const to = store.generationPath(destination.generation);
    assert.deepEqual(await store.active(), source);
    const files = ["el/database", "bn/database", "shared/key", "admission.json"];
    for (const [index, file] of files.entries()) {
      await Deno.writeFile(join(from, file), new Uint8Array([0, 1, 255, index]));
      await Deno.chmod(join(from, file), index === 2 ? 0o400 : 0o640);
      await Deno.utime(join(from, file), 1_700_000_000, 1_700_000_000);
    }
    await Deno.chmod(join(from, "el"), 0o750);
    const snapshot = join(store.root, "snapshots", "keep");
    await Deno.writeTextFile(snapshot, "saved snapshot");
    await infra.copyGeneration(store, source, destination);
    assert.deepEqual(await store.active(), source);
    for (const file of files) {
      assert.deepEqual(await Deno.readFile(join(to, file)), await Deno.readFile(join(from, file)));
      const old = await Deno.stat(join(from, file));
      const copied = await Deno.stat(join(to, file));
      for (const property of ["mode", "uid", "gid", "mtime"] as const) {
        assert.deepEqual(copied[property], old[property], `${file}: ${property}`);
      }
    }
    assert.equal((await Deno.stat(join(to, "el"))).mode, (await Deno.stat(join(from, "el"))).mode);
    assert.equal(
      JSON.parse(await Deno.readTextFile(join(to, "owner.json"))).generation,
      destination.generation,
    );
    assert.equal(await Deno.readTextFile(snapshot), "saved snapshot");
  });
});

Deno.test("copy refuses live, unverified, foreign and self generations without overwriting files", async (t) => {
  for (
    const invalid of [
      "running",
      "missing checkpoint",
      "foreign source",
      "foreign destination",
      "self",
    ]
  ) {
    await t.step(invalid, async () => {
      await fixture(async ({ store, infra, source, destination }) => {
        const before = await fileInventory(store.generationPath(destination.generation));
        let selectedSource = source;
        let selectedDestination = destination;
        if (invalid === "running") await store.write({ ...source, phase: "running" });
        if (invalid === "missing checkpoint") {
          await store.write({ ...source, checkpoint: undefined });
        }
        if (invalid === "foreign source") selectedSource = { ...source, id: "another-owner" };
        if (invalid === "foreign destination") {
          selectedDestination = { ...destination, id: "another-owner" };
        }
        if (invalid === "self") selectedDestination = source;
        await assert.rejects(infra.copyGeneration(store, selectedSource, selectedDestination));
        assert.deepEqual(await fileInventory(store.generationPath(destination.generation)), before);
      });
    });
  }
});

Deno.test("copy refuses an active or nonempty destination and a mismatching Infrastructure owner", async () => {
  await fixture(async ({ store, infra, source, destination }) => {
    const to = store.generationPath(destination.generation);
    const existing = join(to, "el", "do-not-overwrite");
    await Deno.writeTextFile(existing, "existing data");
    await assert.rejects(infra.copyGeneration(store, source, destination), /empty/i);
    assert.equal(await Deno.readTextFile(existing), "existing data");
    await Deno.remove(existing);
    const other = new Infrastructure("another-owner");
    await assert.rejects(other.copyGeneration(store, source, destination), /owner/i);
    await store.write(destination);
    await assert.rejects(infra.copyGeneration(store, source, destination));
    assert.deepEqual(await store.active(), destination);
  });
});

Deno.test("copy checks live containers by exact owner and generation and holds the ownership lock", async () => {
  await fixture(async ({ store, infra, source, destination }) => {
    const observed: string[][] = [];
    infra.docker.listContainers = ((options: { filters: { label: string[] } }) => {
      observed.push(options.filters.label);
      assert(options.filters.label.includes(`${LABEL}=${store.id}`));
      assert(
        options.filters.label.some((label) =>
          label === `${GENERATION}=${source.generation}` ||
          label === `${GENERATION}=${destination.generation}`
        ),
      );
      return Promise.resolve([{ Id: "owned-live-client", State: "running" }]);
    }) as typeof infra.docker.listContainers;
    await assert.rejects(infra.copyGeneration(store, source, destination), /running|live|client/i);
    assert(observed.length > 0);
    infra.docker.listContainers = (() => Promise.resolve([])) as typeof infra.docker.listContainers;
    const lock = await StateLock.acquire(join(store.root, "network.lock"));
    try {
      await assert.rejects(
        infra.copyGeneration(store, source, destination),
        /owned by live process/,
      );
    } finally {
      lock.release();
    }
  });
});

Deno.test("copy rejects links and special files before copying any generation data", async (t) => {
  for (const unsafe of ["file link", "directory link", "fifo"]) {
    await t.step(unsafe, async () => {
      await fixture(async ({ store, infra, source, destination, base }) => {
        const from = store.generationPath(source.generation);
        const to = store.generationPath(destination.generation);
        await Deno.writeTextFile(join(from, "el", "ordinary"), "must not copy before validation");
        const path = join(from, "shared", "unsafe");
        if (unsafe === "fifo") {
          const result = await new Deno.Command("mkfifo", { args: [path] }).output();
          assert(result.success, new TextDecoder().decode(result.stderr));
        } else {
          const external = join(base, "external");
          if (unsafe === "directory link") await Deno.mkdir(external);
          else await Deno.writeTextFile(external, "external data");
          await Deno.symlink(external, path);
        }
        const before = await fileInventory(to);
        await assert.rejects(
          infra.copyGeneration(store, source, destination),
          /link|special|unsupported/i,
        );
        assert.deepEqual(await fileInventory(to), before);
        assert.deepEqual(await store.active(), source);
      });
    });
  }
});

Deno.test("a partial copy stays inactive and cannot overwrite its own incomplete destination on retry", async () => {
  await fixture(async ({ store, infra, source, destination }) => {
    const from = store.generationPath(source.generation);
    const to = store.generationPath(destination.generation);
    await Deno.writeTextFile(join(from, "el", "first"), "copied");
    await Deno.writeTextFile(join(from, "el", "second"), "interrupted");
    const copy = Deno.copyFile;
    let copied = 0;
    Deno.copyFile = async (source, target) => {
      if (++copied === 2) throw new Error("injected disk failure");
      await copy(source, target);
    };
    try {
      await assert.rejects(
        infra.copyGeneration(store, source, destination),
        /injected disk failure/,
      );
    } finally {
      Deno.copyFile = copy;
    }
    assert.equal(await Deno.readTextFile(join(to, "el", "first")), "copied");
    await assert.rejects(Deno.stat(join(to, "el", "second")), Deno.errors.NotFound);
    assert.deepEqual(await store.active(), source);
    await assert.rejects(infra.copyGeneration(store, source, destination), /empty/i);
  });
});

Deno.test("copy refuses changed source or damaged destination bytes without publishing them", async (t) => {
  for (const changed of ["source", "destination"] as const) {
    await t.step(changed, async () => {
      await fixture(async ({ store, infra, source, destination }) => {
        const from = join(store.generationPath(source.generation), "el", "database");
        const to = join(store.generationPath(destination.generation), "el", "database");
        await Deno.writeTextFile(from, "checkpoint bytes");
        const originalCopy = Deno.copyFile;
        Deno.copyFile = async (sourcePath, targetPath) => {
          if (String(sourcePath) === from && changed === "source") {
            // A stopped phase must not turn an unobserved concurrent edit into a valid copy.
            await Deno.writeTextFile(from, "different bytes!");
          }
          await originalCopy(sourcePath, targetPath);
          if (String(targetPath) === to && changed === "destination") {
            await Deno.writeTextFile(to, "damaged");
          }
        };
        try {
          await assert.rejects(
            infra.copyGeneration(store, source, destination),
            /changed|integrity|copy/i,
          );
        } finally {
          Deno.copyFile = originalCopy;
        }
        assert.deepEqual(await store.active(), source);
        assert.equal(
          await Deno.readTextFile(from),
          changed === "source" ? "different bytes!" : "checkpoint bytes",
        );
      });
    });
  }
});
