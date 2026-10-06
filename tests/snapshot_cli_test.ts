import assert from "node:assert/strict";
import { snapshotCommand } from "../src/snapshot_cli.ts";

const snapshot = "c767e2b1-c056-4c58-bd22-3231c5613287";
const operation = "e2729ae6-52d4-489b-a9d3-54e2942d0b16";

Deno.test("snapshot CLI preserves reusable snapshot and separate operation identities", () => {
  for (const action of ["create", "restore", "remove"]) {
    const args = action === "create" ? [action] : [action, snapshot];
    assert.deepEqual(snapshotCommand([...args, "--operation", operation]), {
      action,
      id: action === "create" ? undefined : snapshot,
      path: undefined,
      operation,
    });
  }
  assert.deepEqual(snapshotCommand(["export", snapshot, "./fixture.panda.gz"]), {
    action: "export",
    id: snapshot,
    path: "./fixture.panda.gz",
    operation: undefined,
  });
  assert.equal(snapshotCommand(["operation", operation]).id, operation);
  assert.equal(snapshotCommand(["list"]).action, "list");
});

Deno.test("snapshot CLI rejects ignored flags, missing arguments and unsafe identities", () => {
  for (
    const args of [
      ["list", "--operation", operation],
      ["export", snapshot, "fixture.gz", "--operation", operation],
      ["operation", operation, "--operation", operation],
      ["restore"],
      ["export", snapshot],
      ["create", snapshot],
      ["list", snapshot],
      ["restore", "../outside"],
      ["create", "--operation", "invalid"],
      ["create", "--operation"],
      ["create", "--unknown"],
      ["create", "--operation", operation, "--operation", operation],
    ]
  ) assert.throws(() => snapshotCommand(args), Error, args.join(" "));
});
