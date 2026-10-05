# Panda HTTP API

Base URL: `http://127.0.0.1:8545`. Start the Docker service using the [README](../README.md). The
[OpenAPI 3.1 specification](openapi.json) and [command reference](api-reference.md) are generated
from the shared TypeScript contracts in `src/api_contract.ts`. Client generation belongs in the
consuming project. Use the specification from the same Git revision as your Panda image; older
images may lack checkpoint/snapshot features.

## Requests and results

Send `{method, params}` to `POST /control`. Parameters are positional; `params` may be omitted for
commands with no arguments. Most successes return `{"result": ...}`. `snapshotOperation` returns
`{}` for an unknown operation UUID; `shutdown` returns `{"id": "network-owner"}`. This endpoint uses
Panda's control protocol, not JSON-RPC 2.0.

```sh
curl --fail-with-body http://127.0.0.1:8545/control \
  -H 'Content-Type: application/json' \
  -d '{"method":"advanceTime","params":[384,{"mode":"fast"}]}'
```

Time commands return `{"result":{"now":2000000384,"slot":32}}` for a network started at Unix time
2000000000 and advanced by 384 seconds. `now`, durations and `advanceTo` targets use seconds with
millisecond precision. Snapshot/checkpoint `nowMs` uses milliseconds. Slot and epoch counts are
non-negative integers; an epoch contains 32 slots. Time cannot move backwards; restore replaces the
active branch with saved state.

See the generated [command reference](api-reference.md) for every method, positional argument and
result.

`honest` is the default advancement mode. Explicit `fast` mode permits missed duties and inactivity
penalties. See [protocol time](../README.md#protocol-time). Validator public keys use `0x` plus 96
hex characters. Import and exit completion means the native API accepted the operation; observe
Beacon state for activation, exit and withdrawal completion.

## Snapshots and lifecycle

`GET /lifecycle` returns lifecycle state directly, without a result envelope. It remains available
while native clients are stopped or faulted. Check `checkpointCapable` before using stop/resume or
snapshots; `ready` reports whether ordinary network requests can be admitted.

Create snapshots at a completed slot tail with no pending or unresolved transaction submissions.
Generate and retain a unique lowercase UUID for each snapshot mutation before sending it:

```json
{ "method": "snapshotCreate", "params": ["00000000-0000-4000-8000-000000000001"] }
```

The UUID above is illustrative; use a fresh UUID for each new operation. The returned snapshot ID
identifies saved state and is separate from the operation ID. If the connection is lost, query
`snapshotOperation` with the original operation ID before deciding what to do next. A timeout does
not cancel or roll back accepted work. A failed operation may retain a snapshot or report a separate
cleanup failure; inspect `state`, `stage`, `result`, `error` and `cleanup`.

Restore keeps public URLs stable, disables automine and returns a new `sessionId`. Reset external
providers, subscriptions and indexer state for the replacement branch. Ordinary time commands never
rewind. See [lifecycle and recovery](lifecycle.md) for compatibility, persistence and failure
handling.

`GET /snapshots/{id}/archive` streams `application/gzip`. `Content-Length` reports compressed bytes;
`X-Panda-Sha256` reports their SHA-256. Consume or cancel the stream and verify its checksum when
saving or transferring it. Startup from a local or HTTPS archive uses container/CLI configuration;
there is no remote archive-upload endpoint.

## Errors and client generation

Panda returns JSON `{error}` with HTTP 500 for a failed command while ready, or HTTP 503 when the
service is in maintenance, parked or faulted. Foreign Host/Origin requests receive HTTP 403 text;
unknown routes receive HTTP 404 text. Long operations use a one-hour server guard; configure client
deadlines for your test. After a disconnect, the server may still finish an accepted mutation.

The specification has one `control` operation with request variants selected by `method`, plus
`lifecycle` and `downloadSnapshot`. A generated client follows these routes; the document does not
invent a REST endpoint for each command. Select tooling that supports OpenAPI 3.1 positional arrays
(`prefixItems`) and keep generated clients in the consuming project.

Ethereum JSON-RPC at `/`, Beacon proxies at `/cl/` and `/eth/`, and Keymanager at `/vc/` retain
their upstream contracts: [EL](https://ethereum.github.io/execution-apis/),
[Beacon](https://github.com/ethereum/beacon-APIs), and
[Keymanager](https://github.com/ethereum/keymanager-APIs). VC calls require the native bearer token.
Panda's native checkpoint endpoints are private; remote-signer mutations are blocked on
checkpoint-capable networks. See [client ports and logs](ci-containers.md#client-apis-and-logs).

## Updating the reference

Edit shared wire types and JSDoc in `src/api_contract.ts` when changing an API. The HTTP client in
`src/client.ts` imports this contract without importing the controller. `src/api.ts` retains local
Deno startup, file export and owned cleanup for Panda development and tests.

```sh
deno task docs:generate  # Update tracked OpenAPI and Markdown from types.
deno task docs:check     # Reject stale output and invalid contract examples.
deno task docs:reference # Generate HTML at .cache/docs/index.html.
```

`deno task check` includes the documentation check, so existing CI checks catch stale output. Usage
explanations stay in this guide; schemas and command signatures are generated. Route metadata
(paths, HTTP codes and headers) lives in `tools/api-docs/http.json` and contains no DTO definitions.

The documentation tools have a separate Deno config and lockfile under `tools/api-docs/`.
[ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator) reads TypeScript; Ajv
validates generated schemas in tests. Direct versions and all transitive resolutions are pinned.
Generation has read access, selected compiler environment variables and write access only to its two
output files; it has no subprocess, network or FFI permission. Package lifecycle scripts are not
enabled. The Docker context copies runtime sources and the root Deno config/lock, excluding these
tools and their dependencies. HTML uses the built-in
[deno doc](https://docs.deno.com/runtime/reference/cli/doc/) command.
