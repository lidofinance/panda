import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { suiteHash } from "../src/verification.ts";

Deno.test("immutable bake verification ignores other profiles, new build recipes and unrelated tests", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (
      const path of [
        "src",
        "scripts",
        "bakes",
        "tests",
        "deno.json",
        "deno.lock",
      ]
    ) {
      await cp(path, `${root}/${path}`, { recursive: true });
    }
    const pectra = () => suiteHash({ profile: "pectra" }, root);
    const gloas = () => suiteHash({ profile: "gloas" }, root);
    const before = { pectra: await pectra(), gloas: await gloas() };
    const selectedPath = `${root}/bakes/pectra/recipe.json`;
    const original = await Deno.readTextFile(selectedPath);
    const remapped = JSON.parse(original);
    [remapped.tests.baseline, remapped.tests.e2e] = [remapped.tests.e2e, remapped.tests.baseline];
    await Deno.writeTextFile(selectedPath, JSON.stringify(remapped));
    assert.notEqual(await pectra(), before.pectra, "Changing scenario routing changes the suite");
    assert.equal(await gloas(), before.gloas);
    await Deno.writeTextFile(selectedPath, original);
    await Deno.writeTextFile(`${root}/bakes/gloas/tests/gloas.ts`, "\n// new Gloas assertion\n", {
      append: true,
    });
    assert.equal(await pectra(), before.pectra);
    assert.notEqual(await gloas(), before.gloas);
    const beforeCrashFixture = await gloas();
    await Deno.writeTextFile(
      `${root}/bakes/gloas/tests/snapshot_process.ts`,
      "\n// changed crash boundary\n",
      { append: true },
    );
    assert.notEqual(
      await gloas(),
      beforeCrashFixture,
      "The child-process crash fixture belongs to the snapshot suite fingerprint",
    );
    assert.equal(await pectra(), before.pectra);
    const beforeConsumer = await gloas();
    await Deno.writeTextFile(
      `${root}/bakes/shared/tests/snapshot_consumer_process.ts`,
      "\n// changed external consumer replay\n",
      { append: true },
    );
    assert.notEqual(
      await gloas(),
      beforeConsumer,
      "The external consumer process belongs to the snapshot suite fingerprint",
    );
    assert.equal(await pectra(), before.pectra);
    const changedGloas = await gloas();
    for (const profile of ["pectra", "gloas"]) {
      const path = `${root}/bakes/${profile}/recipe.json`;
      const recipe = JSON.parse(await Deno.readTextFile(path));
      recipe.clRef = "a-different-client-for-a-future-bake";
      recipe.patch = `bakes/${profile}/a-new-patch.patch`;
      await Deno.writeTextFile(path, JSON.stringify(recipe));
    }
    await Deno.writeTextFile(`${root}/bakes/shared/controlled_clock.rs`, "new clock source");
    await Deno.writeTextFile(`${root}/tests/profiles_test.ts`, "new baker unit test");
    await Deno.writeTextFile(`${root}/src/baker.ts`, "new build implementation");
    assert.equal(await pectra(), before.pectra);
    assert.equal(await gloas(), changedGloas);
    const defaultsPath = `${root}/bakes/pectra/recipe.json`;
    const defaults = JSON.parse(await Deno.readTextFile(defaultsPath));
    defaults.churnLimitQuotient = 4;
    await Deno.writeTextFile(defaultsPath, JSON.stringify(defaults));
    assert.notEqual(await pectra(), before.pectra);
    assert.equal(await gloas(), changedGloas);
    defaults.churnLimitQuotient = 65536;
    await Deno.writeTextFile(defaultsPath, JSON.stringify(defaults));
    assert.equal(await pectra(), before.pectra);
    await Deno.writeTextFile(
      `${root}/bakes/shared/tests/validators.ts`,
      "\n// shared validator assertion\n",
      { append: true },
    );
    assert.notEqual(await pectra(), before.pectra);
    const shared = await pectra();
    await Deno.writeTextFile(`${root}/src/time.ts`, "\n// changed shared timeline\n", {
      append: true,
    });
    assert.notEqual(await pectra(), shared);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
