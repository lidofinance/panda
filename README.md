# Panda

![Panda — a pixel-art panda and the project wordmark](docs/assets/banner.png)

**Ethereum development with real clients and validators.**

Panda is a local Ethereum development environment built from Geth, a Lighthouse beacon node and real
validators. A Docker image exposes HTTP APIs for network lifecycle, transactions, consensus state
and protocol time.

The goal is to make the full execution and consensus stack practical to use in application
development and integration tests. Start an isolated network, deploy contracts, inspect both layers,
exercise validator workflows and clean up afterward. The clients perform the actual execution,
signing, voting and state transitions.

## What Panda is for

Panda gives tests access to HTTP JSON-RPC, Beacon API and explicit network controls. It is useful
when a scenario depends on how execution, consensus and validators work together:

- **Contracts and applications:** test deployments, receipts, indexers and services against a
  running Ethereum network.
- **Consensus-aware integrations:** inspect Beacon state, validator duties and finality alongside
  execution-layer transactions and balances.
- **Validator workflows:** exercise deposits, activation, exits and withdrawals with the protocol's
  state transitions and delays.
- **Repeatable environments:** start fresh instances, select a hardfork and a pinned client build,
  save a reusable snapshot and restore it between scenarios.
- **Time-dependent scenarios:** pause protocol time, produce individual blocks, advance through
  epochs or test timelocks and expiry against real block timestamps.

## How it works

One Deno process owns the network lifecycle. It manages Geth, a Lighthouse beacon node, a validator
client and a one-shot genesis generator through dockerode. Each instance has its own resource label,
so cleanup is scoped to that instance.

Geth provides the execution layer. A Lighthouse patch gives protocol clocks and schedules an
explicit time source. The controller advances protocol phases and waits for their work to finish; an
Engine API gate coordinates execution payload preparation with those phases. Signature checks,
execution validation and finality remain part of the real client pipeline.

Hardfork profiles cover **Pectra (Prague/Electra)** and the pinned experimental **Gloas
(Amsterdam/Gloas)** implementations. Gloas is the current default; Pectra releases and CI are
temporarily paused. Both use the mainnet preset: 12-second slots, 32-slot epochs and an explicitly
reduced default of 64 genesis validators. Network deadlines, JWT timestamps and watchdogs continue
to use real time, including while protocol time is paused.

## Requirements

- Docker with a running daemon for the service image.
- curl 7.82+ for the HTTP examples below.
- Panda development and local client builds require Deno 2.9.7; see
  [local development](docs/usage.md#setup-and-startup).

## Quick start

Start the latest stable Gloas image (`latest` updates after each successful stable release):

```sh
docker run -d --name panda \
  --pull=always \
  --privileged \
  --stop-timeout 120 \
  -p 127.0.0.1:8545:8545 \
  ghcr.io/lidofinance/panda-gloas:latest
```

Wait for the Docker health status to become `healthy`:

```sh
docker inspect --format '{{.State.Health.Status}}' panda
```

Then advance one slot and inspect the network:

```sh
curl localhost:8545/control --json '{"method":"stepSlot"}'
curl localhost:8545/control --json '{"method":"status"}'
```

API paths on port 8545:

| Path          | Interface                                       |
| ------------- | ----------------------------------------------- |
| `/`           | Ethereum JSON-RPC                               |
| `/control`    | Panda commands                                  |
| `/cl/eth/...` | Beacon API                                      |
| `/vc/...`     | Validator/Keymanager API; bearer token required |

```sh
docker logs panda
docker exec panda panda logs cl --tail 200
docker exec panda panda validator-token
```

For direct client ports (5052/5062), see
[client APIs and logs](docs/ci-containers.md#client-apis-and-logs). See
[CI/container configuration](docs/ci-containers.md) for persistent storage and service examples. Use
`docker stop panda` and `docker rm panda` when finished; use explicit persistent storage when state
must survive container replacement.

## HTTP API

Panda exposes its own controls at `POST /control`, lifecycle state at `GET /lifecycle`, and snapshot
archives at `GET /snapshots/{id}/archive`. The [HTTP guide](docs/http-api.md) explains requests and
failure behavior; the generated [command reference](docs/api-reference.md) lists parameters and
results. The [OpenAPI 3.1 specification](docs/openapi.json) is generated from the shared TypeScript
contract and can be used with a compatible client generator in your project.

Ethereum JSON-RPC, Beacon and Keymanager calls retain their upstream APIs. Use your existing
Ethereum client for transactions and contract calls. Automine is off by default:

```sh
curl localhost:8545/control --json '{"method":"setAutomine","params":[true]}'
```

Checkpoint-capable images support stop/resume and reusable snapshots. Inspect `GET /lifecycle` and
its `checkpointCapable` field first. Restore replaces the chain branch: reset external
providers/indexers explicitly. Container startup from a local or HTTPS snapshot uses
`PANDA_SNAPSHOT`; see [snapshots and lifecycle](docs/lifecycle.md) for compatibility and recovery.

## Protocol time

Protocol time is explicit and can run ahead of the host clock. Use `advanceSlots(n)` or
`advanceEpochs(n)` for continuous block production and validator participation. Poll status between
advances when waiting for a condition in an external test. Advancement only moves forward; restoring
a snapshot explicitly replaces the current branch with the saved state. Advancing time still
requires client computation.

`advanceTime` takes seconds and optional warp options; `advanceTo` takes a Unix timestamp in seconds
and the same options. Both offer two modes on the same bake:

- **`honest` (default):** execute every intermediate phase, block and validator duty up to the exact
  target. The historical estimate for Gloas `direct-sync` is roughly 13 minutes for 8192 slots; the
  complete long-run acceptance remains open.
- **`fast`:** for jumps over 32 slots, finish current duties, skip the gap and produce the
  destination slot. Real missed-duty penalties and delayed finality are expected. Slashing
  protection remains enabled; conflicting signatures are a bug in either mode.

```sh
# Fast advancement by 8192 slots (98304 seconds).
curl localhost:8545/control --json '{"method":"advanceTime","params":[98304,{"mode":"fast"}]}'
```

`skipSlots(n)` remains the lower-level downtime operation without producing the destination block.
Fast regression tests require the jump plus the next transaction within 25 seconds. Honest tests
retain economic and full-duty assertions with a separate long watchdog. See
[the algorithm walkthrough](docs/warp-algorithm.md) for phase barriers, fast recovery and failure
semantics, and [mode validation](docs/warp-modes.md) for measured results and remaining checks.

## Scope and limitations

The current topology is one execution client, one beacon node and one validator client. Public APIs
bind to localhost, and Docker must run locally because the network uses local bind mounts.
Development keys are public and intended only for this environment.

Panda requires trusted source code and Docker access. Use a disposable VM or hosted CI runner for
untrusted changes; the privileged CI image is not a sandbox for hostile code. Keep published ports
on loopback and never use real wallet keys. See [security boundaries](SECURITY.md).

HTTP JSON-RPC is supported. WebSocket, long-lived Beacon SSE, multiple beacon nodes and arbitrary
external validators are outside the current verified scope. Cold resume requires a clean checkpoint
and its exact compatible bake. After unclean loss, explicitly restore a retained snapshot through
the recovery service. Snapshot compatibility is limited to the same owner, bake, configuration and
native platform. Exported archives can start a new owner with compatible clients and configuration.
Dynamic hardfork transitions remain planned. Geth's real-time transaction-pool expiry continues
during a protocol pause.

## Bake profiles

Recipes, patches and profile tests live together under `bakes/<hardfork>/`; reusable parts live in
`bakes/shared/`. See [the bake layout and extension guide](bakes/README.md) to add another hardfork
or build a client version under a new tag.

## Validation

```sh
deno task check
deno task test
deno task e2e # Requires the locally built client image.
```

The default test suite runs unit checks and skips Docker and end-to-end scenarios. Separate
scenarios cover time advancement, automine, finality, validator lifecycle, deployments and resource
ownership. Finality checks compare the Beacon finalized block's execution hash with Geth's finalized
hash.

The [validator lifecycle tests](bakes/shared/tests/README.md) show deposit, activation,
consolidation, signed exit and complete withdrawal as named steps. Run both suites on every
supported hardfork using an existing bake tag:

```sh
PANDA_BAKE=ci-main-merge deno task test:protocol
```

[Measurements and validation](docs/measurements.md) records executed checks, host conditions and raw
reports. Keep resource measurements separate from other devnet tests.

## Documentation

- [HTTP guide](docs/http-api.md) and [OpenAPI](docs/openapi.json) — commands, schemas and examples.
- [Local usage guide](docs/usage.md) — controller configuration and development helpers.
- [Snapshots and lifecycle](docs/lifecycle.md) — save/restore, stop/resume, crash recovery and
  external consumer reset.
- [CI images](docs/ci-containers.md) — versioned hardfork images and CI service integration.
- [Time and warp algorithm](docs/warp-algorithm.md) — start here to understand honest/fast modes,
  execution phases, validator duties, recovery and the source files involved.
- [Architecture](docs/architecture.md) — clock boundaries, client patches and Engine API
  coordination.
- [Project plan](docs/plan.md) — completed work and next steps.

## Author

Created and maintained by [@eddort](https://github.com/eddort).

## License

Panda's original code is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 eddort.

Third-party components retain their own licenses. [Lighthouse](https://github.com/sigp/lighthouse)
uses Apache-2.0; the [Geth executable](https://github.com/ethereum/go-ethereum#license) uses
GPL-3.0-or-later, and the go-ethereum libraries use LGPL-3.0-or-later.
