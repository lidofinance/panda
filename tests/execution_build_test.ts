import assert from "node:assert/strict";
import { atomicJson } from "../src/artifacts.ts";
import type { Infrastructure } from "../src/docker.ts";
import {
  EL_BUILD_REVISION,
  type ExecutionBuild,
  executionBuild,
  executionImage,
} from "../src/execution_build.ts";
import { type Bake, type BakedImage, canonical, profiles, sha256 } from "../src/profiles.ts";

const commit = "1".repeat(40);
const image = (digit: string): BakedImage => ({
  ref: `local-${digit}`,
  id: `sha256:${digit.repeat(64)}`,
  platform: "linux/amd64",
});
const go = image("2"), runtime = image("3"), geth = image("4");
const build = () => executionBuild(profiles.gloas.elRepository, commit, go, runtime);
const owner = (key: string) => `bake-${key.slice(0, 24)}`;
function info(value: BakedImage, label: string) {
  const [Os, Architecture] = value.platform.split("/");
  return { Id: value.id, Os, Architecture, Config: { Labels: { "io.panda.id": label } } };
}

async function fixture() {
  const root = await Deno.makeTempDir();
  const available = new Map<string, ReturnType<typeof info>>();
  const archives = new Map<string, ReturnType<typeof info>>();
  const restored: string[] = [];
  let compiled = 0;
  const infra = {
    docker: {
      getImage: (id: string) => ({
        inspect: () => {
          const found = available.get(id);
          if (!found) throw Object.assign(new Error("Image not found"), { statusCode: 404 });
          return Promise.resolve(found);
        },
      }),
    },
    restoreImage: (id: string) => {
      restored.push(id);
      const found = archives.get(id);
      if (found) available.set(id, found);
      return Promise.resolve(!!found);
    },
    cacheImage: () => Promise.resolve(),
  } as unknown as Infrastructure;
  return {
    root,
    available,
    archives,
    restored,
    get compiled() {
      return compiled;
    },
    run: (selected: ExecutionBuild, duringCompile = () => Promise.resolve()) =>
      executionImage(infra, selected, async () => {
        compiled++;
        await duringCompile();
        const compiledImage = { ...geth, platform: selected.builder.platform };
        available.set(geth.id, info(compiledImage, owner(selected.key)));
        return compiledImage;
      }, root),
    async [Symbol.asyncDispose]() {
      await Deno.remove(root, { recursive: true });
    },
  };
}

// Reproduce the persisted envelope independently, including the otherwise-unrecorded EL revision.
async function legacy(
  overrides: Partial<Bake> = {},
  revision = 2,
  execution?: ExecutionBuild,
): Promise<Bake> {
  const value: Bake = {
    schema: 1,
    profile: "gloas",
    tag: "prior-build",
    key: "",
    createdAt: "2026-01-01T00:00:00Z",
    recipe: { ...profiles.gloas, elRef: commit },
    source: { cl: profiles.gloas.clRef, el: commit },
    hashes: { "clock.rs": "a".repeat(64) },
    images: { el: geth, cl: image("5"), genesis: image("6"), baseline: image("7") },
    builders: { go, runtime, rust: image("8") },
    ...overrides,
  };
  value.key = await sha256(canonical({
    recipe: value.recipe,
    hashes: value.hashes,
    source: value.source,
    builders: value.builders,
    genesis: value.images.genesis,
    baseline: value.images.baseline,
    importedEl: value.source.el ? undefined : value.images.el,
    importedCl: value.source.importedCl ? value.images.cl : undefined,
    lighthouse: value.lighthouse,
    recipeRevision: 3,
    elBuildRevision: value.source.el ? revision : undefined,
    executionBuild: execution,
  }));
  return value;
}

Deno.test("EL artifact survives CL-only changes without recompiling or dropping source provenance", async () => {
  await using f = await fixture();
  const old = await legacy();
  const changed = await legacy({ hashes: { "clock.rs": "b".repeat(64) } });
  assert.notEqual(old.key, changed.key);
  const selected = await build();
  f.archives.set(geth.id, info(geth, owner(old.key)));
  await atomicJson(`${f.root}/artifacts/${old.key}.json`, old);
  assert.deepEqual(await f.run(selected), geth);
  assert.equal(f.compiled, 0, "a changed CL bake must reuse the source-built EL");
  assert.deepEqual(f.restored, [geth.id], "reuse must use the existing archive restore path");
  const cached = JSON.parse(await Deno.readTextFile(`${f.root}/execution/${selected.key}.json`));
  assert.equal(cached.build.source.commit, changed.source.el);
  assert.equal(cached.legacyBake.key, old.key, "ownership belongs to the original build");
  await Deno.remove(`${f.root}/artifacts`, { recursive: true });
  assert.deepEqual(await f.run(selected), geth);
  assert.equal(f.compiled, 0, "migrated independent cache must remain reusable");
});

Deno.test("independent EL artifact compiles once and ignores mutable builder ref aliases", async () => {
  await using f = await fixture();
  const selected = await build();
  await f.run(selected);
  const alias = await executionBuild(profiles.gloas.elRepository, commit, { ...go, ref: "alias" }, {
    ...runtime,
    ref: "runtime-alias",
  });
  assert.equal(alias.key, selected.key);
  await f.run(alias);
  assert.equal(f.compiled, 1);
});

Deno.test("EL identity changes for every source, toolchain, platform and build revision input", async () => {
  const selected = await build();
  const candidates = [
    await executionBuild("https://example.com/other-geth", commit, go, runtime),
    await executionBuild(profiles.gloas.elRepository, "9".repeat(40), go, runtime),
    await executionBuild(profiles.gloas.elRepository, commit, image("9"), runtime),
    await executionBuild(profiles.gloas.elRepository, commit, go, image("9")),
    await executionBuild(profiles.gloas.elRepository, commit, { ...go, platform: "linux/arm64" }, {
      ...runtime,
      platform: "linux/arm64",
    }),
    await executionBuild(profiles.gloas.elRepository, commit, go, runtime, EL_BUILD_REVISION + 1),
  ];
  assert.equal(new Set([selected.key, ...candidates.map((x) => x.key)]).size, 7);
  await assert.rejects(() => executionBuild(profiles.gloas.elRepository, "main", go, runtime));
  await assert.rejects(() =>
    executionBuild(profiles.gloas.elRepository, commit, { ...go, id: "go:latest" }, runtime)
  );
  await assert.rejects(() =>
    executionBuild(profiles.gloas.elRepository, commit, { ...go, platform: "linux/arm64" }, runtime)
  );
});

Deno.test("legacy artifacts cannot authorize a different EL source, builder, runtime or revision", async (t) => {
  const base = await legacy();
  const cases: Record<string, Bake> = {
    repository: await legacy({ recipe: { ...base.recipe, elRepository: "other-repository" } }),
    source: await legacy({
      recipe: { ...base.recipe, elRef: "9".repeat(40) },
      source: { ...base.source, el: "9".repeat(40) },
    }),
    go: await legacy({ builders: { ...base.builders, go: image("9") } }),
    runtime: await legacy({ builders: { ...base.builders, runtime: image("9") } }),
    platform: await legacy({
      images: { ...base.images, el: { ...geth, platform: "linux/arm64" } },
    }),
    revision: await legacy({}, 1),
    imported: await legacy({
      source: { cl: base.source.cl },
      builders: { runtime, rust: image("8") },
    }),
    tampered: { ...base, source: { ...base.source, el: "9".repeat(40) } },
  };
  for (const [name, candidate] of Object.entries(cases)) {
    await t.step(name, async () => {
      await using f = await fixture();
      await atomicJson(`${f.root}/artifacts/${candidate.key}.json`, candidate);
      f.available.set(geth.id, info(geth, owner(candidate.key)));
      await f.run(await build());
      assert.equal(f.compiled, 1, "unproven artifact must not be reused");
      assert.deepEqual(f.restored, []);
    });
  }
});

Deno.test("legacy filename mismatch and corrupt metadata are skipped without reuse", async () => {
  await using f = await fixture();
  const old = await legacy();
  await atomicJson(`${f.root}/artifacts/${"a".repeat(64)}.json`, old);
  await Deno.writeTextFile(`${f.root}/artifacts/${"b".repeat(64)}.json`, "{corrupt");
  f.available.set(geth.id, info(geth, owner(old.key)));
  await f.run(await build());
  assert.equal(f.compiled, 1);
});

Deno.test("missing legacy image bytes do not hide a later usable artifact", async () => {
  await using f = await fixture();
  const candidates = [await legacy(), await legacy({ hashes: { "clock.rs": "c".repeat(64) } })];
  candidates.sort((a, b) => a.key.localeCompare(b.key));
  const [missing, present] = candidates;
  missing.images.el = image("9"); // The old whole key does not include the compiled EL output ID.
  for (const candidate of candidates) {
    await atomicJson(`${f.root}/artifacts/${candidate.key}.json`, candidate);
  }
  f.archives.set(geth.id, info(geth, owner(present.key)));
  await f.run(await build());
  assert.equal(f.compiled, 0);
  assert.deepEqual(f.restored, [missing.images.el.id, geth.id]);
});

Deno.test("missing independent image bytes are a miss and can be rebuilt", async () => {
  await using f = await fixture();
  const selected = await build();
  await atomicJson(`${f.root}/execution/${selected.key}.json`, { build: selected, image: geth });
  await f.run(selected);
  assert.equal(f.compiled, 1);
  assert.deepEqual(f.restored, [geth.id]);
});

Deno.test("independent cache corruption, foreign owners and wrong restored image fail closed", async (t) => {
  const selected = await build();
  for (const test of ["metadata", "json", "owner", "restored-id", "platform"] as const) {
    await t.step(test, async () => {
      await using f = await fixture();
      const path = `${f.root}/execution/${selected.key}.json`;
      await atomicJson(path, {
        build: test === "metadata" ? { ...selected, revision: 99 } : selected,
        image: geth,
      });
      if (test === "json") await Deno.writeTextFile(path, "{corrupt");
      const restored = info(geth, owner(selected.key));
      if (test === "owner") restored.Config.Labels["io.panda.id"] = "another-build";
      if (test === "restored-id") restored.Id = image("9").id;
      if (test === "platform") restored.Architecture = "arm64";
      f.archives.set(geth.id, restored);
      await assert.rejects(() => f.run(selected));
      assert.equal(f.compiled, 0);
    });
  }
});

Deno.test("legacy reuse rejects another bake's owner even if image bytes and source match", async () => {
  await using f = await fixture();
  const selected = await build(), old = await legacy();
  await atomicJson(`${f.root}/artifacts/${old.key}.json`, old);
  f.available.set(geth.id, info(geth, owner(selected.key)));
  await assert.rejects(() => f.run(selected), /ownership/);
  assert.equal(f.compiled, 0);
});

Deno.test("an imported CL does not discard independently proven legacy EL provenance", async () => {
  await using f = await fixture();
  const old = await legacy({
    source: { cl: profiles.gloas.clRef, el: commit, importedCl: image("5").id },
  });
  await atomicJson(`${f.root}/artifacts/${old.key}.json`, old);
  f.available.set(geth.id, info(geth, owner(old.key)));
  assert.deepEqual(await f.run(await build()), geth);
  assert.equal(f.compiled, 0);
});

Deno.test("migrated cache cannot splice another source's image and ownership proof", async () => {
  await using f = await fixture();
  const selected = await build();
  const different = await executionBuild(profiles.gloas.elRepository, "9".repeat(40), go, runtime);
  const old = await legacy();
  const other = await legacy({
    recipe: { ...old.recipe, elRef: "9".repeat(40) },
    source: { ...old.source, el: "9".repeat(40) },
    images: { ...old.images, el: image("9") },
  });
  for (const candidate of [old, other]) {
    await atomicJson(`${f.root}/artifacts/${candidate.key}.json`, candidate);
    f.available.set(candidate.images.el.id, info(candidate.images.el, owner(candidate.key)));
  }
  await f.run(selected);
  await f.run(different);
  const path = `${f.root}/execution/${selected.key}.json`;
  const original = JSON.parse(await Deno.readTextFile(path));
  const another = JSON.parse(await Deno.readTextFile(`${f.root}/execution/${different.key}.json`));
  await atomicJson(path, { ...another, build: original.build });
  await assert.rejects(() => f.run(selected), /provenance/);
  assert.equal(f.compiled, 0);
});

Deno.test("a new complete bake is not mistaken for the old ownership envelope after cache deletion", async () => {
  await using f = await fixture();
  const selected = await build();
  const current = await legacy({}, EL_BUILD_REVISION, selected);
  await atomicJson(`${f.root}/artifacts/${current.key}.json`, current);
  f.available.set(geth.id, info(geth, owner(selected.key)));
  await f.run(selected);
  assert.equal(f.compiled, 1, "deleted independent metadata is a safe cache miss");
});

Deno.test("two stale EL lock reclaimers cannot both compile or replace the lock inode", async () => {
  await using f = await fixture();
  const selected = await build();
  const path = `${f.root}/locks/execution-${selected.key}.lock`;
  await Deno.mkdir(`${f.root}/locks`);
  await Deno.writeTextFile(path, "2147483647");
  const before = await Deno.stat(path);
  const readTextFile = Deno.readTextFile, remove = Deno.remove;
  const bothRead = Promise.withResolvers<void>();
  const firstCompile = Promise.withResolvers<void>();
  const finishCompile = Promise.withResolvers<void>();
  let reads = 0, removes = 0;
  // Force the dangerous legacy schedule: both read the dead PID, then the second unlinks
  // only after the first has acquired its replacement file and entered compilation.
  Deno.readTextFile = async (...args: Parameters<typeof Deno.readTextFile>) => {
    const value = await readTextFile(...args);
    if (args[0] === path) {
      if (++reads === 2) bothRead.resolve();
      await bothRead.promise;
    }
    return value;
  };
  Deno.remove = async (...args: Parameters<typeof Deno.remove>) => {
    if (args[0] === path && ++removes === 2) await firstCompile.promise;
    await remove(...args);
  };
  const attempt = () =>
    f.run(selected, async () => {
      firstCompile.resolve();
      if (f.compiled === 2) finishCompile.resolve();
      await finishCompile.promise;
    }).catch((error) => {
      finishCompile.resolve();
      throw error;
    });
  try {
    const attempts = await Promise.allSettled([attempt(), attempt()]);
    assert.equal(f.compiled, 1, "only one owner may enter the compiler");
    assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal((await Deno.stat(path)).ino, before.ino, "never unlink an ownership inode");
    await f.run(selected);
    assert.equal(f.compiled, 1, "released lock must admit a cache hit");
  } finally {
    Deno.readTextFile = readTextFile;
    Deno.remove = remove;
  }
});
