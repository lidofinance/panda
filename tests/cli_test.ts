import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

Deno.test("up reuses running, parked and recovery controllers unless selection explicitly differs", async (t) => {
  const directory = await Deno.makeTempDir();
  const id = "cli-selection";
  const profile = "gloas";
  const bake = "snapshot-minimal-r1";
  let phase = "running";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    assert.equal(new URL(request.url).pathname, "/control");
    assert.equal((await request.json()).method, "lifecycle");
    return Response.json({ result: { id, profile, bake, phase, ready: phase === "running" } });
  });
  try {
    await Deno.mkdir(`${directory}/${id}`);
    await Deno.writeTextFile(
      `${directory}/${id}/controller.json`,
      JSON.stringify({ url: `http://127.0.0.1:${server.addr.port}` }),
    );
    const environment = Deno.env.toObject();
    delete environment.PANDA_PROFILE;
    delete environment.PANDA_BAKE;
    const run = async (args: string[] = [], env: Record<string, string> = {}) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          "--allow-net=127.0.0.1",
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "up",
          ...args,
        ],
        clearEnv: true,
        env: { ...environment, PANDA_ID: id, PANDA_DATA_DIR: directory, ...env },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: result.code,
        output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
      };
    };
    for (const state of ["running", "parked", "faulted"]) {
      await t.step(`plain up reuses ${state} owner`, async () => {
        phase = state;
        const result = await run();
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /"event":"already-running"/);
      });
    }
    await t.step("matching environment and flags select the existing owner", async () => {
      for (const args of [[], ["--profile", profile, "--bake", bake]]) {
        const result = await run(args, { PANDA_PROFILE: profile, PANDA_BAKE: bake });
        assert.equal(result.code, 0, result.output);
      }
    });
    await t.step("flags take precedence over environment", async () => {
      const result = await run(["--profile", profile, "--bake", bake], {
        PANDA_PROFILE: "pectra",
        PANDA_BAKE: "other",
      });
      assert.equal(result.code, 0, result.output);
    });
    await t.step("explicit conflicts are rejected before starting another network", async () => {
      for (const selection of ["profile", "bake"]) {
        const value = selection === "profile" ? "pectra" : "other";
        for (
          const result of [
            await run([`--${selection}`, value]),
            await run([], { [`PANDA_${selection.toUpperCase()}`]: value }),
          ]
        ) {
          assert.notEqual(result.code, 0, result.output);
          assert.match(result.output, /Running gloas:snapshot-minimal-r1; requested/);
        }
      }
    });
  } finally {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
