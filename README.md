# Panda

![Panda — a pixel-art panda and the project wordmark](docs/assets/banner.png)

**Ethereum development with real clients and validators.**

Panda is a local Ethereum development environment built from Geth, a Lighthouse beacon node and real
validators. One Deno controller manages the clients in Docker and exposes one HTTP endpoint for
JSON-RPC, the Beacon API and network controls: lifecycle, transactions, consensus state and protocol
time. Run it as a Docker image and drive it with `curl` or any Ethereum client library.

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
  and scope cleanup to the instance a test owns.
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

**Gloas (Amsterdam/Gloas)** is the only developed, verified and released profile, and the default.
The **Pectra (Prague/Electra)** profile is kept in the repository as history; it is no longer
maintained, built or published by CI. Gloas uses the mainnet preset: 12-second slots, 32-slot epochs
and an explicitly reduced default of 64 genesis validators. Network deadlines, JWT timestamps and
watchdogs continue to use real time, including while protocol time is paused.

## Requirements

- **Docker** with a running local daemon. The service image runs privileged because it starts its
  own clients inside the container.
- To build clients or run Panda from source: **Deno 2.9.7** on `PATH`.

## Quick start with Docker

```sh
docker run -d --name panda --privileged --stop-timeout 120 \
  -p 127.0.0.1:8545:8545 -p 127.0.0.1:5052:5052 -p 127.0.0.1:5062:5062 \
  -v panda-data:/data \
  ghcr.io/lidofinance/panda-gloas:latest
```

The network is ready when `docker ps` reports the container as `healthy`. Pin an image digest in CI
instead of `latest`. `docker stop panda` preserves the network in the `panda-data` volume for the
next start; remove the container and the volume to discard it. See
[CI images](docs/ci-containers.md) for CI services, native client ports, logs and the validator API
token.

## HTTP API

Everything goes through `http://127.0.0.1:8545`: `/` is Geth JSON-RPC, `/eth/v1/...` and
`/eth/v2/...` are the Beacon API, and `POST /control` runs Panda commands. Native Lighthouse Beacon
and validator APIs are also published on ports 5052 and 5062.

```sh
curl http://127.0.0.1:8545 --json '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
curl http://127.0.0.1:8545/eth/v1/beacon/headers/head
curl http://127.0.0.1:8545/control --json '{"method":"status","params":[]}'
curl http://127.0.0.1:8545/control --json '{"method":"advanceEpochs","params":[2]}'
```

Control commands use the same request shape and return `{"result": ...}`; failures return
`{"error": "..."}` with a non-2xx status.

| Method                                              | Params                                      | Effect                                      |
| --------------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| `status`                                            | `[]`                                        | Slot, protocol time, latest block, finality |
| `stepSlot`                                          | `[]`                                        | Produce one block and complete its duties   |
| `advanceSlots`, `advanceEpochs`                     | `[count]`                                   | Produce blocks with full participation      |
| `advanceTime`                                       | `[seconds]` or `[seconds, {"mode":"fast"}]` | Advance by a duration                       |
| `advanceTo`                                         | `[unixSeconds]` (optional mode)             | Advance to a timestamp                      |
| `skipSlots`                                         | `[count]`                                   | Downtime without the destination block      |
| `setAutomine`                                       | `[true]` or `[false]`                       | Mine eligible pending transactions          |
| `importValidator`, `exitValidator`                  | see [usage](docs/usage.md)                  | Validator lifecycle                         |
| `snapshotCreate`, `snapshotRestore`, `snapshotList` | see [snapshots](docs/snapshots.md)          | Save and restore the whole network          |

Automine is off by default. With it enabled, point ethers, viem, Foundry or any JSON-RPC client at
`http://127.0.0.1:8545` and wait for receipts as usual.

## Snapshots

Save the whole network (both databases, validator keys and signing history, protocol time) and
return to it as often as needed. `snapshotCreate` returns the snapshot `id`; restore keeps the same
URLs and returns a new `sessionId`.

```sh
curl http://127.0.0.1:8545/control --json '{"method":"snapshotCreate","params":[]}'
curl http://127.0.0.1:8545/control --json '{"method":"snapshotList","params":[]}'
curl http://127.0.0.1:8545/control --json '{"method":"snapshotRestore","params":["<id>"]}'
curl -o fixture.panda.gz http://127.0.0.1:8545/snapshots/<id>/archive
```

Start a new container from an exported archive (local file or HTTPS URL):

```sh
docker run -d --name panda --privileged --stop-timeout 120 -p 127.0.0.1:8545:8545 \
  -v "$PWD/fixture.panda.gz:/seed/fixture.panda.gz:ro" -e PANDA_SNAPSHOT=/seed/fixture.panda.gz \
  ghcr.io/lidofinance/panda-gloas:latest
```

See [snapshots](docs/snapshots.md) for operation IDs, retries, recovery and limitations.

## Protocol time

Protocol time is explicit and can run ahead of the host clock. Time only moves forward, and
advancing it still requires client computation. `advanceTime` and `advanceTo` offer two modes on the
same image:

- **`honest` (default):** execute every intermediate phase, block and validator duty up to the exact
  target. The historical estimate for Gloas `direct-sync` is roughly 13 minutes for 8192 slots; the
  complete long-run acceptance remains open.
- **`fast`:** for jumps over 32 slots, finish current duties, skip the gap and produce the
  destination slot. Real missed-duty penalties and delayed finality are expected. Slashing
  protection remains enabled; conflicting signatures are a bug in either mode.

```sh
curl http://127.0.0.1:8545/control --json '{"method":"advanceTime","params":[98304,{"mode":"fast"}]}'
```

`skipSlots` remains the lower-level downtime operation without producing the destination block. Fast
regression tests require the jump plus the next transaction within 25 seconds. Honest tests retain
economic and full-duty assertions with a separate long watchdog. See
[the algorithm walkthrough](docs/warp-algorithm.md) for phase barriers, fast recovery and failure
semantics, and [mode validation](docs/warp-modes.md) for measured results and remaining checks.

## Run from source

Building clients takes time; client compilation is separate from ordinary network startup.

```sh
deno task smoke:docker
deno task bake gloas --tag local
deno task test:profile gloas --bake local
deno task up --profile gloas --bake local
```

`deno task up` serves the same HTTP API on `http://127.0.0.1:8545`. Press Ctrl-C to preserve the
network for the next startup, or run `deno task down` in another terminal to remove it.
`deno task reset --profile gloas --bake local` starts again with fresh state. Use `PANDA_ID` and
`PANDA_PORT` for separate instances.

## Scope and limitations

The current topology is one execution client, one beacon node and one validator client. Public APIs
bind to localhost, and Docker must run locally because the network uses local bind mounts.
Development keys are public and intended only for this environment.

Panda requires trusted source code and Docker access. Use a disposable VM or hosted CI runner for
untrusted changes; the privileged CI image is not a sandbox for hostile code. Keep published ports
on loopback and never use real wallet keys. See [security boundaries](SECURITY.md).

HTTP JSON-RPC is supported. WebSocket, long-lived Beacon SSE, multiple beacon nodes and arbitrary
external validators are outside the current verified scope. Controlled Gloas supports clean
stop/resume and reusable [full-network snapshots](docs/snapshots.md), including startup from local
files or HTTPS. Unclean process loss requires explicit recovery. Geth's real-time transaction-pool
expiry continues during a protocol pause.

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

- [Usage guide](docs/usage.md) — configuration, API details, ethers settings and troubleshooting.
- [Snapshots](docs/snapshots.md) — save and restore the full network, export fixtures and seed
  startup.
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
