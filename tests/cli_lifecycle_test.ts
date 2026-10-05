import assert from "node:assert/strict";
import { resolve } from "node:path";

Deno.test("CLI checks existing controller ownership through lifecycle while clients are stopped", async () => {
  const directory = await Deno.makeTempDir();
  const calls: string[] = [];
  let owner = "fixture";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const { method } = await request.json();
    calls.push(method);
    if (method !== "lifecycle") {
      return Response.json({ error: "client RPC unavailable" }, { status: 503 });
    }
    return Response.json({
      result: { id: owner, profile: "gloas", bake: "default", ready: false, phase: "parked" },
    });
  });
  try {
    await Deno.mkdir(`${directory}/.panda/fixture`, { recursive: true });
    await Deno.writeTextFile(
      `${directory}/.panda/fixture/controller.json`,
      JSON.stringify({ url: `http://127.0.0.1:${server.addr.port}` }),
    );
    const run = (command: string) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", `--config=${resolve("deno.json")}`, resolve("src/cli.ts"), command],
        cwd: directory,
        env: {
          PANDA_ID: "fixture",
          PANDA_PROFILE: "gloas",
          PANDA_BAKE: "default",
          PANDA_DATA_DIR: `${directory}/.panda`,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const up = await run("up");
    assert.equal(up.code, 0, new TextDecoder().decode(up.stderr));
    assert.match(new TextDecoder().decode(up.stdout), /already-running/);
    owner = "different-owner";
    const down = await run("down");
    assert.notEqual(down.code, 0);
    assert.match(new TextDecoder().decode(down.stderr), /ownership mismatch/);
    assert.deepEqual(calls, ["lifecycle", "lifecycle"]);
  } finally {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
