// Documentation only: use Deno's own parser, with no runtime schema or SDK dependency.
export function snapshotDocs(doc) {
  if (doc.version !== 2) throw new Error(`Unsupported Deno doc version: ${doc.version}`);
  const symbols = new Map(
    Object.values(doc.nodes).flatMap((node) =>
      node.symbols.map((symbol) => [symbol.name, symbol.declarations])
    ),
  );
  const schemas = Object.create(null);
  const description = (value) => value.jsDoc?.doc ? { description: value.jsDoc.doc } : {};
  const unsupported = (kind) => {
    throw new Error(`Unsupported snapshot documentation type: ${kind}`);
  };
  function object(def) {
    for (const key of ["methods", "callSignatures", "indexSignatures", "extends", "typeParams"]) {
      if (def[key]?.length) unsupported(key);
    }
    const properties = {};
    const required = [];
    for (const prop of def.properties ?? []) {
      if (prop.computed || !prop.tsType) unsupported(prop.name);
      properties[prop.name] = { ...schema(prop.tsType), ...description(prop) };
      if (!prop.optional) required.push(prop.name);
    }
    return {
      type: "object",
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    };
  }
  function declaration(name) {
    const declarations = symbols.get(name);
    if (declarations?.length !== 1) unsupported(name);
    return declarations[0];
  }
  function reference(name) {
    if (!(name in schemas)) {
      const item = declaration(name);
      schemas[name] = {}; // Permit references back to a type currently being converted.
      if (item.kind === "interface") schemas[name] = object(item.def);
      else if (item.kind === "typeAlias" && !item.def.typeParams?.length) {
        schemas[name] = schema(item.def.tsType);
      } else unsupported(item.kind);
      Object.assign(schemas[name], description(item));
    }
    return { $ref: `#/components/schemas/${name}` };
  }
  function schema(type) {
    const { kind, value } = type;
    switch (kind) {
      case "keyword":
        if (value === "unknown") return {};
        if (["string", "number", "boolean"].includes(value)) return { type: value };
        break;
      case "literal":
        if (["string", "number", "boolean"].includes(value.kind)) {
          return { const: value[value.kind] };
        }
        break;
      case "union":
        return { anyOf: value.map(schema) };
      case "array":
        return { type: "array", items: schema(value) };
      case "tuple":
        return {
          type: "array",
          ...(value.length ? { prefixItems: value.map(schema) } : {}),
          items: false,
          minItems: value.length,
          maxItems: value.length,
        };
      case "typeLiteral":
        return object(value);
      case "typeOperator": {
        if (value.operator !== "keyof" || value.tsType.kind !== "typeQuery") break;
        const source = declaration(value.tsType.value).def.tsType;
        if (source.kind !== "typeLiteral") break;
        return { anyOf: source.value.properties.map((prop) => ({ const: prop.name })) };
      }
      case "typeRef":
        if (!value.typeParams?.length) return reference(value.typeName);
        break;
    }
    return unsupported(kind);
  }
  const commands = declaration("SnapshotCommands").def.properties;
  const requests = [];
  const results = [];
  for (const command of commands) {
    const wire = schema(command.tsType);
    requests.push({
      ...wire,
      ...description(command),
      properties: { method: { const: command.name }, params: wire.properties.params },
      required: ["method", ...(wire.required.includes("params") ? ["params"] : [])],
    });
    results.push({
      type: "object",
      properties: { result: wire.properties.result },
      additionalProperties: false,
      ...(wire.required.includes("result") ? { required: ["result"] } : {}),
    });
  }
  const json = (schema) => ({ "application/json": { schema } });
  const response = (description, schema, type = "application/json") => ({
    description,
    content: { [type]: { schema } },
  });
  const failure = reference("SnapshotControlError");
  const responses = (schema, type) => ({
    "200": response("Requested result. Unknown snapshotOperation returns {}.", schema, type),
    "403": response("Foreign Host/Origin.", { type: "string" }, "text/plain"),
    "500": response(
      "Request failed; inspect lifecycle and any recorded operation for current state.",
      failure,
    ),
    "503": response("Request failed while ingress is closed or not ready.", failure),
  });
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Panda snapshots",
      version: "unreleased",
      description: "Snapshot/lifecycle subset. See docs/snapshots.md for usage and startup import.",
    },
    servers: [{ url: "http://127.0.0.1:8545" }],
    paths: {
      "/control": {
        post: {
          operationId: "snapshotControl",
          requestBody: { required: true, content: json({ oneOf: requests }) },
          responses: responses({ anyOf: results }),
        },
      },
      "/lifecycle": {
        get: {
          operationId: "snapshotLifecycle",
          responses: responses(reference("SnapshotLifecycle")),
        },
      },
      "/snapshots/{id}/archive": {
        get: {
          operationId: "exportSnapshot",
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          }],
          responses: responses({ type: "string", format: "binary" }, "application/gzip"),
        },
      },
    },
    components: { schemas },
  };
  spec.paths["/snapshots/{id}/archive"].get.responses["200"].headers = {
    "X-Panda-SHA256": {
      description: "Compressed-file SHA-256.",
      schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    "Content-Length": {
      description: "Compressed byte count.",
      schema: { type: "integer", minimum: 0 },
    },
  };
  function typeName(value) {
    if (value.$ref) return value.$ref.split("/").at(-1);
    if (value.anyOf) return value.anyOf.map(typeName).join(" or ");
    if ("const" in value) return JSON.stringify(value.const);
    if (value.type === "array") {
      return value.items === false
        ? `[${(value.prefixItems ?? []).map(typeName).join(", ")}]`
        : `${typeName(value.items)}[]`;
    }
    return value.type ?? "any JSON";
  }
  const lines = [
    "# Snapshot API reference",
    "",
    "Generated from `src/snapshot_types.ts`. Regenerate with `deno task docs:snapshots`; verify with `deno task docs:snapshots --check`.",
    "",
    "[Usage and lifecycle contract](snapshots.md) · [OpenAPI 3.1](snapshots-openapi.json)",
    "",
    'POST `/control` with `{"method":"snapshotList","params":[]}`; responses wrap `{"result":...}`. This reference covers snapshots and lifecycle only. Supply operation UUIDs for safe retries; omission generates a new ID.',
    "",
    "| Method | Parameters | Result | Behavior |",
    "| --- | --- | --- | --- |",
    ...commands.map((command, index) =>
      `| \`${command.name}\` | \`${typeName(requests[index].properties.params)}\`${
        requests[index].required.includes("params") ? "" : " (optional)"
      } | \`${typeName(results[index].properties.result)}\`${
        results[index].required ? "" : " (optional)"
      } | ${command.jsDoc?.doc ?? ""} |`
    ),
    "",
    "An unknown `snapshotOperation` returns `{}`. Errors use `SnapshotControlError`: inspect lifecycle and any recorded operation after HTTP 500; HTTP 503 indicates closed or unready ingress. Foreign Host/Origin requests receive 403 with plain text.",
    "",
    "GET `/lifecycle` returns `SnapshotLifecycle` directly. GET `/snapshots/{id}/archive` returns gzip bytes with `X-Panda-SHA256` and `Content-Length`. Import via startup `--snapshot` or `PANDA_SNAPSHOT`, not an HTTP upload.",
  ];
  lines.push(
    "",
    "Field types, required properties and descriptions are defined in the linked OpenAPI schemas.",
  );
  return { spec, markdown: `${lines.join("\n")}\n` };
}

if (import.meta.main) {
  if (Deno.args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: snapshot_docs.js [--check]");
  }
  const cwd = new URL("..", import.meta.url);
  const parsed = await new Deno.Command(Deno.execPath(), {
    cwd,
    args: ["doc", "--json", "src/snapshot_types.ts", "src/profiles.ts"],
  }).output();
  if (!parsed.success) throw new Error(new TextDecoder().decode(parsed.stderr));
  const { spec, markdown } = snapshotDocs(JSON.parse(new TextDecoder().decode(parsed.stdout)));
  for (
    const [path, value] of [["docs/snapshots-openapi.json", JSON.stringify(spec)], [
      "docs/snapshots-api.md",
      markdown,
    ]]
  ) {
    const fmt = new Deno.Command(Deno.execPath(), {
      cwd,
      args: ["fmt", `--ext=${path.endsWith("json") ? "json" : "md"}`, "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const input = fmt.stdin.getWriter();
    await input.write(new TextEncoder().encode(value));
    await input.close();
    const formatted = await fmt.output();
    if (!formatted.success) throw new Error(`Formatting failed: ${path}`);
    const text = new TextDecoder().decode(formatted.stdout);
    const file = new URL(path, cwd);
    if (Deno.args.includes("--check")) {
      if (await Deno.readTextFile(file) !== text) {
        throw new Error(`Stale ${path}; run deno task docs:snapshots`);
      }
    } else await Deno.writeTextFile(file, text);
    console.log(`${Deno.args.includes("--check") ? "Checked" : "Generated"} ${path}`);
  }
}
