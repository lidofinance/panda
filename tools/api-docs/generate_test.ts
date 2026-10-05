import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/2020";
import { documents } from "./generate.js";

Deno.test("generated wire schemas retain arguments, results and named warp options", () => {
  const outputs = documents();
  const spec = JSON.parse(outputs["docs/openapi.json"]);
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile({
    $ref: "#/components/schemas/ControlRequest",
    components: spec.components,
  });
  for (const params of [[12], [12, { mode: "fast" }]]) {
    assert(validate({ method: "advanceTime", params }));
  }
  for (
    const params of [["12"], [12, false], [12, { mode: "quick" }], [12, {}, 7]]
  ) assert(!validate({ method: "advanceTime", params }));
  assert(!validate({ method: "snapshotRestore" }));
  assert(validate({ method: "status" }));
  assert(outputs["docs/api-reference.md"].includes("options: WarpOptions"));
  const time = ajv.compile(spec.components.schemas.TimeState);
  assert(time({ now: 12.5, slot: 1 }));
  assert(!time({ now: 12 }));
  const operation = ajv.compile({
    $ref: "#/components/schemas/SnapshotOperation",
    components: spec.components,
  });
  const record = {
    schema: 1,
    owner: "test",
    id: "id",
    state: "succeeded",
    stage: "done",
    createdAt: "now",
    updatedAt: "now",
  };
  const snapshot = {
    id: "id",
    createdAt: "now",
    profile: "gloas",
    bakeKey: "key",
    nowMs: 0,
    headSlot: 0,
    headBlockRoot: "root",
  };
  assert(
    operation({ ...record, request: { kind: "create" }, result: snapshot }),
  );
  assert(
    !operation({
      ...record,
      request: { kind: "create" },
      result: { snapshot, generation: "g", sessionId: "s", nowMs: 0 },
    }),
  );
});

Deno.test("tracked API documents match their source types", async () => {
  for (const [path, expected] of Object.entries(documents())) {
    assert.equal(await Deno.readTextFile(path), expected, `${path}: run deno task docs:generate`);
  }
});

Deno.test("contract command names cover the controller dispatch", async () => {
  const spec = JSON.parse(documents()["docs/openapi.json"]);
  const documented = Object.keys(spec.components.schemas.ControlCommands.properties).sort();
  const source = await Deno.readTextFile("src/controller.ts");
  const dispatch = source.slice(
    source.indexOf("  async command("),
    source.indexOf("  private async proxy("),
  );
  const implemented = [...dispatch.matchAll(/(?:method === |case )"([A-Za-z]+)"/g)].map((match) =>
    match[1]
  );
  assert.deepEqual(documented, [...new Set(implemented)].sort());
});
