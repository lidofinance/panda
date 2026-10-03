import assert from "node:assert/strict";
import { scenarioArguments } from "../scripts/scenario_runner.ts";
import { testProfiles } from "../bakes/shared/tests/test_steps.ts";
import { profiles } from "../src/profiles.ts";

Deno.test("protocol lifecycles default to active Gloas, with an explicit historical profile selector", () => {
  assert.deepEqual(testProfiles(undefined), ["gloas"]);
  for (const profile of Object.keys(profiles)) assert.deepEqual(testProfiles(profile), [profile]);
  assert.throws(() => testProfiles("unsupported"), /Unknown hardfork/);
});

Deno.test("profile wrapper forwards both its default and an explicitly selected hardfork", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const fixture = `${directory}/selected_profile_test.ts`;
    const harness = `${directory}/runner_test.ts`;
    const catalog = new URL("../src/profiles.ts", import.meta.url).href;
    const runner = new URL("./e2e_test.ts", import.meta.url).href;
    for (const selected of [undefined, "pectra"]) {
      const expected = selected ?? "gloas";
      await Deno.writeTextFile(
        fixture,
        `Deno.test("selected profile", () => {
          if (Deno.env.get("PANDA_PROFILE") !== ${JSON.stringify(expected)}) {
            throw new Error("Profile wrapper did not forward its selected hardfork");
          }
        });`,
      );
      await Deno.writeTextFile(
        harness,
        `import { profiles } from ${JSON.stringify(catalog)};
        Deno.env.delete("PANDA_PROFILE");
        ${selected ? `Deno.env.set("PANDA_PROFILE", ${JSON.stringify(selected)});` : ""}
        for (const recipe of Object.values(profiles)) {
          Object.assign(recipe, { tests: { protocol: ${JSON.stringify(fixture)} } });
        }
        await import(${JSON.stringify(runner)});`,
      );
      const result = await new Deno.Command(Deno.execPath(), {
        args: scenarioArguments(harness),
        env: { PANDA_E2E: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const output = new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);
      assert.equal(result.code, 0, output);
      assert.match(output, new RegExp(`real ${expected}: deposit, activation and consolidation`));
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("profile runner executes named tests and fails when a nested protocol step fails", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/lifecycle_test.ts`;
    await Deno.writeTextFile(
      path,
      `
      Deno.test("validator lifecycle", async (t) => {
        await t.step("deposit reaches CL", () => {});
        await t.step("withdrawal reaches EL", () => { throw new Error("missing withdrawal"); });
      });
    `,
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: scenarioArguments(path),
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assert.notEqual(result.code, 0, "A registered but unexecuted test must not count as passing");
    assert.match(output, /deposit reaches CL/);
    assert.match(output, /withdrawal reaches EL/);
    assert.match(output, /missing withdrawal/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a failed lifecycle stage skips dependent stages and still disposes its fixture", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/failure_test.ts`;
    const disposed = `${directory}/disposed`;
    const helper = new URL("../bakes/shared/tests/test_steps.ts", import.meta.url).href;
    await Deno.writeTextFile(
      path,
      `
      import { step } from ${JSON.stringify(helper)};
      Deno.test("dependent lifecycle", async (t) => {
        await using fixture = {
          async [Symbol.asyncDispose]() { await Deno.writeTextFile(${
        JSON.stringify(disposed)
      }, "cleaned"); }
        };
        await step(t, "deposit fails", async () => { throw new Error("rejected deposit"); });
        await step(t, "must not consolidate", async () => { console.log("UNSAFE_NEXT_STAGE"); });
      });
    `,
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: scenarioArguments(path),
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assert.notEqual(result.code, 0);
    assert.match(output, /Stopped after failed step: deposit fails/);
    // Ignore the error's source-code excerpt: the subsequent step must never run or be reported.
    assert.doesNotMatch(
      new TextDecoder().decode(result.stdout),
      /^\s*must not consolidate \.\.\./m,
    );
    assert.doesNotMatch(new TextDecoder().decode(result.stdout), /^UNSAFE_NEXT_STAGE$/m);
    assert.equal(await Deno.readTextFile(disposed), "cleaned");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("profile runner retains existing script scenarios", async () => {
  const path = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(path, 'console.log("script scenario executed");');
    const result = await new Deno.Command(Deno.execPath(), {
      args: scenarioArguments(path),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 0);
    assert.match(new TextDecoder().decode(result.stdout), /script scenario executed/);
  } finally {
    await Deno.remove(path);
  }
});
