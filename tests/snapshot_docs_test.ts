import assert from "node:assert/strict";
import { snapshotDocs } from "../scripts/snapshot_docs.js";

Deno.test("snapshot docs derive wire shapes and reject unsupported type changes", async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", "src/snapshot_types.ts", "src/profiles.ts"],
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  const doc = JSON.parse(new TextDecoder().decode(result.stdout));
  const { spec, markdown } = snapshotDocs(doc);
  const requests = spec.paths["/control"].post.requestBody.content["application/json"].schema.oneOf;
  const request = (name: string) =>
    requests.find((item: { properties: { method: { const: string } } }) =>
      item.properties.method.const === name
    );
  assert.deepEqual(request("snapshotCreate").required, ["method"]);
  assert.deepEqual(request("snapshotRestore").required, ["method", "params"]);
  assert.deepEqual(
    request("snapshotRestore").properties.params.anyOf.map((item: { minItems: number }) =>
      item.minItems
    ),
    [1, 2],
  );
  assert.equal(request("snapshotList").properties.params.maxItems, 0);
  const responses = spec.paths["/control"].post.responses["200"].content["application/json"].schema;
  assert.ok(responses.anyOf.some((item: { required?: string[] }) => !item.required));
  assert.deepEqual(spec.components.schemas.ProfileName.anyOf, [
    { const: "pectra" },
    { const: "gloas" },
  ]);
  assert.ok(markdown.includes("snapshotRestore"));
  assert.ok(!JSON.stringify(spec).includes("file:///"));
  assert.ok(!("SavedState" in spec.components.schemas));

  // A changed source type must change the spec, never silently produce an empty schema.
  const source = doc.nodes[new URL("../src/snapshot_types.ts", import.meta.url).href];
  const ref = source.symbols.find((symbol: { name: string }) => symbol.name === "SnapshotRef");
  ref.declarations[0].def.properties.push({
    name: "newRequiredField",
    tsType: { kind: "keyword", value: "boolean" },
  });
  assert.ok(
    snapshotDocs(doc).spec.components.schemas.SnapshotRef.required.includes("newRequiredField"),
  );
  ref.declarations[0].def.properties.at(-1).tsType = { kind: "conditional" };
  assert.throws(() => snapshotDocs(doc), /Unsupported.*conditional/);
});
