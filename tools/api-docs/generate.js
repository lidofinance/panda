import { createGenerator } from "ts-json-schema-generator";
import metadata from "./http.json" with { type: "json" };

/** Read TypeScript; never import or execute the controller to describe its API. */
export function documents() {
  const generator = createGenerator({
    path: "src/api_contract.ts",
    tsconfig: "tools/api-docs/tsconfig.json",
    expose: "export",
    jsDoc: "extended",
    strictTuples: true,
    additionalProperties: false,
  });
  const definitions = Object.assign(
    {},
    ...[
      "ControlCommands",
      "ControlRequest",
      "ControlResponse",
      "ControlError",
    ].map((name) => generator.createSchema(name).definitions),
  );
  const names = new Map(
    Object.keys(definitions).map((name) => [
      name,
      name.replace(/[^a-zA-Z0-9_.-]/g, "_"),
    ]),
  );
  if (new Set(names.values()).size !== names.size) {
    throw new Error("Schema name collision");
  }
  // The generator emits draft-07; OpenAPI 3.1 uses 2020-12 tuples and component references.
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "$schema" || key === "additionalItems") continue;
      if (key === "$ref") {
        const name = names.get(
          decodeURIComponent(item.replace("#/definitions/", "")),
        );
        if (!name) throw new Error(`Unresolved reference: ${item}`);
        result.$ref = `#/components/schemas/${name}`;
      } else if (key === "items" && Array.isArray(item)) {
        result.prefixItems = item.map(normalize);
        result.items = normalize(value.additionalItems ?? false);
      } else result[key] = normalize(item);
    }
    return result;
  }
  const schemas = Object.fromEntries([...names].map(([source, name]) => [
    name,
    normalize(definitions[source]),
  ]));
  const spec = { ...structuredClone(metadata), components: { schemas } };
  const dereference = (schema) => schema.$ref ? schemas[schema.$ref.split("/").at(-1)] : schema;
  function describe(schema) {
    if (schema.$ref) return schema.$ref.split("/").at(-1);
    if (schema.anyOf) return schema.anyOf.map(describe).join(" or ");
    if (schema.type === "array") {
      if (schema.prefixItems) {
        return `[${
          schema.prefixItems.map((s) => `${s.title ?? "value"}: ${describe(s)}`)
            .join(", ")
        }]`;
      }
      if (schema.maxItems === 0) return "[]";
      if (schema.maxItems === 1) {
        return `[${schema.items.title ?? "value"}: ${describe(schema.items)}]`;
      }
      return `${describe(schema.items)}[]`;
    }
    return schema.type ?? "JSON";
  }
  let reference =
    "# Panda API reference\n\nGenerated from `src/api_contract.ts` by `deno task docs:generate`. Do not edit manually.\n\n";
  reference +=
    "POST `{method, params}` to `/control`; success returns `{result}`. See [HTTP usage](http-api.md) for errors, operation IDs and lifecycle behavior.\n\n";
  reference += "| Command | Parameters | Result | Behavior |\n| --- | --- | --- | --- |\n";
  for (
    const [name, schema] of Object.entries(schemas.ControlCommands.properties)
  ) {
    const command = dereference(schema);
    reference += `| \`${name}\` | \`${describe(dereference(command.properties.params))}\` | \`${
      describe(command.properties.result)
    }\` | ${command.description ?? ""} |\n`;
  }
  reference +=
    "\n`shutdown` accepts no arguments and returns `{id}` without a result envelope. An unknown `snapshotOperation` returns `{}`. `GET /lifecycle` returns lifecycle state directly. `GET /snapshots/{id}/archive` streams a gzip archive with its SHA-256 header.\n";
  return {
    "docs/openapi.json": JSON.stringify(spec, null, 2) + "\n",
    "docs/api-reference.md": reference,
  };
}

if (import.meta.main) {
  for (const [path, contents] of Object.entries(documents())) {
    if (Deno.args.includes("--check")) {
      if (await Deno.readTextFile(path) !== contents) {
        throw new Error(`${path} is stale: deno task docs:generate`);
      }
    } else await Deno.writeTextFile(path, contents);
  }
}
