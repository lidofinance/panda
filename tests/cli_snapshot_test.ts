import assert from "node:assert/strict";
import { resolve } from "node:path";
import { canonical, sha256 } from "../src/profiles.ts";
import { StateStore } from "../src/storage.ts";

Deno.test("CLI snapshot commands keep snapshot references separate from operation IDs", async () => {
  const directory = await Deno.makeTempDir({ prefix: "panda-cli-snapshot-" });
  const snapshot = crypto.randomUUID();
  const operation = crypto.randomUUID();
  const calls: { method: string; params: unknown[] }[] = [];
  const archive = new Uint8Array([0x1f, 0x8b, 1, 2]);
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    if (request.method === "GET") {
      assert.equal(new URL(request.url).pathname, `/snapshots/${snapshot}/archive`);
      return new Response(archive, {
        headers: { "content-type": "application/gzip", "x-panda-sha256": await sha256(archive) },
      });
    }
    const call = await request.json();
    calls.push(call);
    return Response.json({
      result: call.method === "lifecycle" ? { id: "fixture" } : { action: call.method },
    });
  });
  try {
    await Deno.mkdir(`${directory}/fixture`);
    await Deno.writeTextFile(
      `${directory}/fixture/controller.json`,
      JSON.stringify({ url: `http://127.0.0.1:${server.addr.port}` }),
    );
    for (
      const [args, method, params] of [
        [["create", "--operation", operation], "snapshotCreate", [operation]],
        [["restore", snapshot, "--operation", operation], "snapshotRestore", [snapshot, operation]],
        [["remove", snapshot, "--operation", operation], "snapshotRemove", [snapshot, operation]],
        [["list"], "snapshotList", []],
        [["operation", operation], "snapshotOperation", [operation]],
      ] as const
    ) {
      calls.length = 0;
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          `--config=${resolve("deno.json")}`,
          resolve("src/cli.ts"),
          "snapshot",
          ...args,
        ],
        cwd: directory,
        env: { PANDA_ID: "fixture", PANDA_DATA_DIR: directory },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
      assert.deepEqual(calls, [{ method: "lifecycle", params: [] }, { method, params }]);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), { action: method });
    }
    const path = `${directory}/cli-export.gz`;
    const exported = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        `--config=${resolve("deno.json")}`,
        resolve("src/cli.ts"),
        "snapshot",
        "export",
        snapshot,
        path,
      ],
      cwd: directory,
      env: { PANDA_ID: "fixture", PANDA_DATA_DIR: directory },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(exported.code, 0, new TextDecoder().decode(exported.stderr));
    assert.deepEqual(await Deno.readFile(path), archive);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(exported.stdout)), {
      path,
      sha256: await sha256(archive),
      bytes: archive.length,
    });
  } finally {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CLI can inspect and finish removal offline after the previous controller died", async () => {
  const directory = await Deno.makeTempDir({ prefix: "panda-cli-offline-" });
  const previous = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", directory);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response(),
  );
  const port = server.addr.port;
  await server.shutdown();
  try {
    const store = new StateStore("fixture");
    await store.initialize();
    const saved = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      profile: "gloas",
      bakeKey: "00".repeat(32),
      nowMs: 47_500,
      headSlot: 3,
      headBlockRoot: `0x${"11".repeat(32)}`,
    };
    const body = { schema: 1, owner: store.id, snapshot: saved };
    await Deno.writeTextFile(
      `${store.root}/snapshots/.removed-${saved.id}.json`,
      JSON.stringify({ ...body, checksum: await sha256(canonical(body)) }),
    );
    await Deno.writeTextFile(
      `${store.root}/controller.json`,
      JSON.stringify({ url: `http://127.0.0.1:${port}` }),
    );
    const operation = crypto.randomUUID();
    for (
      const args of [["list"], ["remove", saved.id, "--operation", operation], [
        "operation",
        operation,
      ]]
    ) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          `--config=${resolve("deno.json")}`,
          resolve("src/cli.ts"),
          "snapshot",
          ...args,
        ],
        env: { PANDA_ID: store.id, PANDA_DATA_DIR: directory },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
      const value = JSON.parse(new TextDecoder().decode(result.stdout));
      if (args[0] === "list") assert.deepEqual(value, []);
      if (args[0] === "remove") assert.deepEqual(value, saved);
      if (args[0] === "operation") assert.equal(value.state, "succeeded");
    }
  } finally {
    if (previous === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", previous);
    await Deno.remove(directory, { recursive: true });
  }
});
