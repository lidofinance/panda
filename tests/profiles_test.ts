import assert from "node:assert/strict";
import { argumentsFor } from "../src/arguments.ts";
import { atomicJson, BuildLock } from "../src/artifacts.ts";
import { snapshotSources } from "../src/baker.ts";
import { configuration } from "../src/config.ts";
import { bakePath, bakeTag, canonical, profileName, profiles, sha256 } from "../src/profiles.ts";
import { Timeline } from "../src/time.ts";

Deno.test("bake and build:clients default to Gloas and retain explicit profile selection", async () => {
  for (const script of ["bake.ts", "build.ts"]) {
    for (const profile of [undefined, "gloas", "pectra"]) {
      // Both profiles have this immutable tag. An override must be rejected before Docker access;
      // the diagnostic identifies the profile selected by the real CLI.
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--config=deno.json",
          "--allow-read",
          "--allow-env",
          "--allow-write=.cache/baker/locks",
          `scripts/${script}`,
          ...profile ? [profile] : [],
          "--tag",
          "panda",
          "--cl-ref",
          "test-override",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.success, false);
      assert.match(
        new TextDecoder().decode(result.stderr),
        new RegExp(`Bake ${profile ?? "gloas"}:panda already exists`),
      );
    }
  }
});
Deno.test("hardfork profiles reject unknown names and unsafe bake paths", () => {
  for (const name of ["main", "../gloas", "toString"]) assert.throws(() => profileName(name));
  for (const tag of ["../x", "", "a/b", "A", "x".repeat(65)]) assert.throws(() => bakeTag(tag));
  assert.equal(bakePath("gloas", "my-build.2"), "bakes/gloas/tags/my-build.2.json");
  assert.equal(configuration({ profile: "gloas" }).churnLimitQuotient, 32768);
  assert.equal(configuration({ profile: "pectra" }).churnLimitQuotient, 65536);
  assert.equal(
    configuration({ profile: "gloas", churnLimitQuotient: 4 }).consolidationChurnLimitQuotient,
    65536,
  );
  assert.throws(() => configuration({ consolidationChurnLimitQuotient: 0 }));
});
Deno.test("build identity is independent of JSON key ordering and changes with patch/source/platform", async () => {
  const key = async (value: unknown) => await sha256(canonical(value));
  assert.equal(await key({ sha: "a", patch: "b" }), await key({ patch: "b", sha: "a" }));
  assert.notEqual(await key({ sha: "a", patch: "b" }), await key({ sha: "a", patch: "c" }));
  assert.notEqual(await key({ platform: "linux/arm64" }), await key({ platform: "linux/amd64" }));
});
Deno.test("each hardfork's timeline executes its declared phases and completes a full slot", async () => {
  for (const profile of Object.values(profiles)) {
    const moves: [number, number | undefined][] = [];
    const time = new Timeline(0, 11500, {
      move: (at, phase) => {
        moves.push([at, phase]);
        return Promise.resolve();
      },
    }, profile.phases);
    await time.stepSlot();
    assert.deepEqual(moves, profile.phases.map((p) => [12000 + p, p]));
    assert.equal(time.slot, 1);
    assert.equal(time.timestamp, 23.5);
  }
  assert(Object.hasOwn(profiles.gloas.tests, "gloas"));
  for (const profile of Object.values(profiles)) {
    assert.equal(Reflect.get(profile.tests, "warp-fast"), "bakes/shared/tests/warp_fast.ts");
    assert.equal(
      Reflect.get(profile.tests, "warp-economics"),
      "bakes/shared/tests/warp_economics.ts",
    );
  }
  for (const profile of Object.values(profiles)) {
    for (const scenario of ["e2e", "protocol", "withdrawal", "deploy"]) {
      assert(Object.hasOwn(profile.tests, scenario));
    }
  }
});
Deno.test("bake lock protects a running build and atomic publication preserves prior records", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/bake.lock`;
    {
      await using _lock = await BuildLock.acquire(path);
      await assert.rejects(() => BuildLock.acquire(path), /owned by process/);
      await atomicJson(`${dir}/bake.json`, { key: "old" });
      await assert.rejects(() => atomicJson(`${dir}/bake.json`, 1n));
      assert.deepEqual(JSON.parse(await Deno.readTextFile(`${dir}/bake.json`)), { key: "old" });
    }
    await using _lock = await BuildLock.acquire(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test("CLI parses hardfork/tag without consuming control arguments and rejects typos", () => {
  assert.deepEqual(
    argumentsFor(["advanceTime", "24", "--profile", "gloas", "--bake", "trial"], [
      "profile",
      "bake",
    ]),
    { positional: ["advanceTime", "24"], flags: { profile: "gloas", bake: "trial" } },
  );
  assert.throws(() => argumentsFor(["--profle", "gloas"], ["profile"]));
  assert.throws(() => argumentsFor(["--profile"], ["profile"]));
});

Deno.test("native tests keep their baked source snapshot after edits and reject archive corruption", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/clock.rs`;
    await Deno.writeTextFile(file, "original clock");
    const hashes = { [file]: await sha256("original clock") };
    assert.equal((await snapshotSources(hashes, `${dir}/snapshot`))[file], "original clock");
    await Deno.writeTextFile(file, "new clock for another bake");
    assert.equal((await snapshotSources(hashes, `${dir}/snapshot`))[file], "original clock");
    await Deno.writeTextFile(`${dir}/snapshot/sources.json`, JSON.stringify({ [file]: "corrupt" }));
    await assert.rejects(() => snapshotSources(hashes, `${dir}/snapshot`), /does not match bake/);
    await assert.rejects(
      () => snapshotSources(hashes, `${dir}/missing`),
      /Missing archived native source/,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
