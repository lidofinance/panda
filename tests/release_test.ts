import assert from "node:assert/strict";
import { profiles, readBake } from "../src/profiles.ts";
import {
  assertMissingRevision,
  lighthouseImage,
  releaseImage,
  releaseMetadata,
} from "../src/release.ts";

Deno.test("each registered fork has its own immutable revision namespace", () => {
  for (const profile of Object.keys(profiles)) {
    assert.equal(
      releaseImage("EdDort", profile, "v1.2.3"),
      `ghcr.io/eddort/panda-${profile}:v1.2.3`,
    );
  }
  for (
    const revision of [
      "latest",
      "main",
      "r1",
      "v01.2.3",
      "v1.2",
      "v1.2.3+build",
      "../v1.2.3",
      "v1.2.3;echo",
    ]
  ) {
    assert.throws(() => releaseImage("eddort", "gloas", revision));
  }
  assert.throws(() => releaseImage("eddort", "unknown", "v1.2.3"));
  assert.throws(() => releaseImage("owner/repo", "gloas", "v1.2.3"));
});

Deno.test("release metadata binds source, bake, all client identities and actual architecture", async () => {
  const bake = await readBake("gloas", "panda");
  const image = releaseImage("eddort", bake.profile, "v1.2.3");
  const commit = "a".repeat(40);
  const metadata = releaseMetadata(bake, image, commit);
  assert.deepEqual(metadata, {
    schema: 1,
    image,
    profile: "gloas",
    revision: "v1.2.3",
    sourceCommit: commit,
    bake: "panda",
    bakeKey: bake.key,
    platform: bake.images.cl.platform,
    clients: bake.images,
  });
  assert.throws(() => releaseMetadata(bake, releaseImage("eddort", "pectra", "v1.2.3"), commit));
  assert.throws(() => releaseMetadata(bake, image, "main"));
  const wrong = structuredClone(bake);
  wrong.images.el.platform = "linux/other";
  assert.throws(() => releaseMetadata(wrong, image, commit));
});

Deno.test("publishing refuses existing revisions, authorization errors and registry outages", () => {
  assert.doesNotThrow(() => assertMissingRevision(404));
  for (const status of [200, 301, 401, 403, 429, 500, 503]) {
    assert.throws(() => assertMissingRevision(status));
  }
});

Deno.test("Panda release selection takes its version from a Git tag, never manual revision input", async () => {
  const output = await Deno.makeTempFile();
  try {
    const run = (ref: string) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "--config=deno.json", "-A", "scripts/release_ci.ts", "matrix", "all"],
        env: { GITHUB_REF: ref, GITHUB_REPOSITORY_OWNER: "eddort", GITHUB_OUTPUT: output },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const branch = await run("refs/heads/main");
    assert.equal(branch.success, false);
    assert.match(new TextDecoder().decode(branch.stderr), /Git tag/);
    const tag = await run("refs/tags/v1.2.3-rc.1");
    assert.equal(tag.success, true, new TextDecoder().decode(tag.stderr));
    const values = Object.fromEntries(
      (await Deno.readTextFile(output)).trim().split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    assert.equal(values.revision, "v1.2.3-rc.1");
    assert.deepEqual(JSON.parse(values.matrix), {
      include: ["gloas"].map((profile) => ({
        profile,
        image: `ghcr.io/eddort/panda-${profile}:v1.2.3-rc.1`,
      })),
    });
  } finally {
    await Deno.remove(output);
  }
});

Deno.test("release entry points reject paused Pectra before accessing the registry", async () => {
  for (
    const [script, commands] of [
      ["lighthouse_ci.ts", ["matrix", "resolve", "publish"]],
      ["release_ci.ts", ["matrix", "check"]],
    ] as const
  ) {
    for (const command of commands) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--config=deno.json",
          "-A",
          "--deny-net",
          `scripts/${script}`,
          command,
          "pectra",
        ],
        env: { GITHUB_REF: "refs/tags/v1.2.3", GITHUB_REPOSITORY_OWNER: "eddort" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.success, false);
      assert.match(new TextDecoder().decode(result.stderr), /pectra.*temporarily disabled/i);
    }
  }
  for (const command of ["check", "open"]) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config=deno.json", "-A", "--deny-net", "scripts/release_pr.ts", command],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: "eddort/panda",
        DEFAULT_BRANCH: "main",
        PANDA_VERSION: "v1.2.3",
        PROFILE: "pectra",
        GH_TOKEN: "test-token-never-sent",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.success, false);
    assert.match(new TextDecoder().decode(result.stderr), /pectra.*temporarily disabled/i);
  }
});

Deno.test("Lighthouse tags identify upstream version/commit and baker version/content", () => {
  const tag = "v8.2.2-2d281dfa1b40-b1-0123456789ab";
  for (const profile of Object.keys(profiles)) {
    assert.equal(
      lighthouseImage("EdDort", profile, tag),
      `ghcr.io/eddort/panda-lighthouse-${profile}:${tag}`,
    );
  }
  for (
    const invalid of ["r1", "latest", "v8.2.2", "v8.2.2-b1", "v8.2.2-2d281dfa1b40-b0-0123456789ab"]
  ) {
    assert.throws(() => lighthouseImage("eddort", "gloas", invalid));
  }
});
