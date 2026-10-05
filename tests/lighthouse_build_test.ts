import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import {
  assertLighthouseImage,
  clientBakeTag,
  lighthouseBuild,
  lighthouseSourceVersion,
  lighthouseTag,
} from "../src/lighthouse_build.ts";
import { profiles, type Recipe } from "../src/profiles.ts";
import { registryDigest } from "../src/registry.ts";

Deno.test("Lighthouse identity changes with either upstream or baker, independently of Panda and Geth", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const path of ["src", "scripts", "bakes", "deno.lock", "deno.json"]) {
      await cp(path, `${root}/${path}`, { recursive: true });
    }
    const recipe: Recipe = structuredClone(profiles.pectra);
    const initial = await lighthouseBuild(recipe, "linux/amd64", root);
    const originalTag = lighthouseTag(initial);
    assert.match(originalTag, /^v7\.1\.0-cfb1f7331064-b1-[a-f0-9]{12}$/);
    for (
      const update of [
        { clVersion: "7.2.0" },
        { clRef: "a".repeat(40) },
        { bakerVersion: 2 },
        { rust: `rust@sha256:${"b".repeat(64)}` },
      ]
    ) {
      const next = await lighthouseBuild({ ...recipe, ...update }, "linux/amd64", root);
      assert.notEqual(next.key, initial.key);
      assert.notEqual(lighthouseTag(next), originalTag);
    }
    assert.notEqual((await lighthouseBuild(recipe, "linux/arm64", root)).key, initial.key);
    const elUpdate = { ...recipe, elImage: `geth@sha256:${"a".repeat(64)}` };
    const unchanged = await lighthouseBuild(elUpdate, "linux/amd64", root);
    assert.deepEqual(unchanged, initial);
    assert.notEqual(await clientBakeTag(elUpdate, unchanged), await clientBakeTag(recipe, initial));
    await Deno.writeTextFile(`${root}/src/controller.ts`, "\n// new Panda controller release\n", {
      append: true,
    });
    await Deno.writeTextFile(`${root}/bakes/gloas/lighthouse.patch`, "\n# another fork's patch\n", {
      append: true,
    });
    assert.deepEqual(await lighthouseBuild(recipe, "linux/amd64", root), initial);
    for (const path of ["src/baker.ts", recipe.patch, recipe.clockSource]) {
      const original = await Deno.readFile(`${root}/${path}`);
      await Deno.writeTextFile(`${root}/${path}`, "\n// changed baker input\n", { append: true });
      const changed = await lighthouseBuild(recipe, "linux/amd64", root);
      assert.notEqual(changed.baker.hash, initial.baker.hash, path);
      assert.notEqual(lighthouseTag(changed), originalTag, path);
      await Deno.writeFile(`${root}/${path}`, original);
    }
    await assert.rejects(
      () => lighthouseBuild({ ...recipe, rust: "rust:latest" }, "linux/amd64", root),
      /pinned Rust/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("upstream version is read from direct and workspace Cargo package versions", () => {
  assert.equal(
    lighthouseSourceVersion('[package]\nname = "lighthouse"\nversion = "7.1.0"\n', ""),
    "7.1.0",
  );
  assert.equal(
    lighthouseSourceVersion(
      "[package]\nversion = { workspace = true }\n",
      '[workspace.package]\nversion = "8.2.2"\n[workspace.dependencies]\n',
    ),
    "8.2.2",
  );
  assert.throws(
    () =>
      lighthouseSourceVersion(
        '[package]\nname = "lighthouse"\n[dependencies]\nversion = "1.0.0"',
        "",
      ),
    /Cannot determine/,
  );
});

Deno.test("published native clients must match both versions and architecture before reuse", async () => {
  const build = await lighthouseBuild(profiles.gloas, "linux/amd64");
  const image = {
    Os: "linux",
    Architecture: "amd64",
    Config: { Labels: { "io.panda.lighthouse.build": JSON.stringify(build) } },
  };
  assert.doesNotThrow(() => assertLighthouseImage(build, image));
  assert.throws(
    () =>
      assertLighthouseImage(
        { ...build, baker: { ...build.baker, version: build.baker.version + 1 } },
        image,
      ),
    /identity mismatch/,
  );
  assert.throws(
    () =>
      assertLighthouseImage(
        { ...build, upstream: { ...build.upstream, commit: "a".repeat(40) } },
        image,
      ),
    /identity mismatch/,
  );
  assert.throws(
    () => assertLighthouseImage(build, { ...image, Architecture: "arm64" }),
    /identity mismatch/,
  );
  assert.throws(() => assertLighthouseImage(build, { ...image, Config: {} }), /identity mismatch/);
});

Deno.test("registry lookup reuses existing immutable images and builds only on confirmed absence", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(registryDigest(200, digest), digest);
  assert.equal(registryDigest(404, null), undefined);
  assert.throws(() => registryDigest(200, null), /immutable manifest digest/);
  for (const status of [301, 401, 403, 429, 500, 503]) {
    assert.throws(() => registryDigest(status, null));
  }
});

Deno.test("Lighthouse workflow derives upstream/baker tags without a manual revision", async () => {
  const output = await Deno.makeTempFile();
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config=deno.json",
        "-A",
        "scripts/lighthouse_ci.ts",
        "matrix",
        "all",
      ],
      env: { GITHUB_REPOSITORY_OWNER: "eddort", GITHUB_OUTPUT: output },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
    const matrix = JSON.parse((await Deno.readTextFile(output)).trim().slice("matrix=".length));
    assert.equal(matrix.include.length, Object.keys(profiles).length);
    for (const item of matrix.include) {
      assert.equal(item.tag, lighthouseTag(item.build));
      assert.equal(item.image, `ghcr.io/eddort/panda-lighthouse-${item.profile}:${item.tag}`);
      assert.match(item.bake, /^ci-[a-f0-9]{40}$/);
    }
  } finally {
    await Deno.remove(output);
  }
});
