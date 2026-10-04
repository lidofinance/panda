# Stop and resume

Controlled Gloas networks with bakes declaring `checkpointAbi: 1` support a clean stop and cold
resume. Historical bakes without that capability cannot produce a verified checkpoint. Reusable
snapshot archives and hardfork schedules are later work in the
[implementation plan](snapshots-hardforks-plan.md).

## SDK and local controller

```ts
import { Devnet } from "../src/api.ts";

await using net = await Devnet.start({ id: "resume-example", profile: "gloas", bake: "local" });
await net.advanceSlots(3);
const checkpoint = await net.stop();
console.log(checkpoint.headBlockRoot, await net.lifecycle());
await net.resume();
await net.stepSlot();
```

`stop()` closes managed EL/CL/VC admission, drains accepted requests and automine, checks unresolved
EL submissions and parks validator duties. It obtains a durable native Lighthouse receipt, then
stops VC, BN and EL in that order. It does not advance protocol time. Use a completed slot tail:
`advanceSlots()` and `stepSlot()` finish there; an arbitrary partial `advanceTime()` may not.

`resume()` opens the same databases at exactly the saved time. Lighthouse starts parked; Panda
verifies the receipt, EL/CL heads, validator keys and signing protection before releasing duties.
Public URLs stay unchanged, `sessionId` changes, and automine remains off. SDK waits from the old
session fail with `SessionChangedError`; restart those waits and external subscriptions.

`lifecycle()` and `GET /lifecycle` do not call EL or CL. They remain available during maintenance,
after a clean stop and after a detected advancement failure. They expose readiness and the last
operation's result or error. An unresolved or ambiguous transaction submission blocks a clean stop,
even if Geth's txpool is empty. Panda never retries a submission automatically.

An owning SDK's `close()` (including `await using`) destroys its active runtime. A borrowed
`new Devnet(url)` connection's `close()` only disconnects that client. CLI `down`, `reset` and the
local foreground controller's Ctrl-C retain destructive semantics for active runtime data.

```sh
deno run -A src/cli.ts stop
deno run -A src/cli.ts lifecycle
deno run -A src/cli.ts resume
```

`Devnet.open(config)` and `deno run -A src/cli.ts open --profile gloas --bake local` open an
existing clean checkpoint when there is no current owning controller. They never create fresh
genesis as a fallback. Use the same ID, configuration, exact bake and native platform.

## Persistent container service

Mount one named volume for Panda state and give graceful shutdown 120 seconds:

```sh
docker run -d --name panda --privileged --stop-timeout 120 \
  --label io.panda.id=my-panda-service \
  -v panda-state:/data/panda \
  -p 127.0.0.1:18547:8545 \
  -p 127.0.0.1:5052:5052 \
  -p 127.0.0.1:5062:5062 \
  ghcr.io/eddort/panda-gloas@sha256:<checkpoint-capable-image-digest>

docker stop --time 120 panda
docker start panda
```

For Compose use `stop_grace_period: 2m`. The service preserves a checkpoint on SIGTERM and opens it
on the next start. An already successful SDK `stop()` is not repeated during SIGTERM. Historical
images without checkpoint capability retain their explicitly reported ephemeral shutdown behavior.

SIGTERM during startup cancels pending readiness checks and waits for owned Docker operations before
cleanup. An unfinished fresh generation is removed, so the next start can create genesis. An
interrupted resume retains its existing generation as faulted; it never falls back to fresh genesis.
Interrupted startup exits with an error and does not publish readiness or claim a clean checkpoint.

A refused save, client crash, SIGKILL or exhausted shutdown budget is not a clean checkpoint. The
next start refuses unverified active data rather than silently creating genesis or rolling back.
Keep the volume for diagnosis. Reusable archive recovery is part of the later snapshot API.

The volume contains private keys, passwords, signing history and databases; do not publish it as an
ordinary CI log artifact. Local state defaults to ignored `.panda/<id>`; `PANDA_DATA_DIR` changes
the parent directory. An atomic pointer identifies one generation, with separate EL, BN and
shared/VC directories. Cleanup of the active generation preserves other generations and the reserved
snapshots directory.

## Diagnostic logs

`down`, `reset`, clean stops, startup failures and `diagnose` save client output under
`.panda/<id>/logs/<generation>/` (or the same path under `PANDA_DATA_DIR`). The files are `el.log`,
`bn.log` and `vc.log`; genesis and EL initialization also save `genesis.log` and `init.log`.
Containers from older runtimes without a generation label use `logs/runtime/`.

These logs survive deletion of the active runtime and stay outside checkpoint databases and keys.
Each save keeps the latest 300 lines and replaces that client's saved output for the same
generation. Remove old generation log directories when no longer needed. For a running client,
`panda logs el`, `panda logs cl` and `panda logs vc` read its current container output.

## Managed client access

Use the SDK's `beaconUrl` and `validatorUrl`, the main API's `/cl/` and `/vc/` prefixes, or
container ports 5052 and 5062. All pass through the same maintenance gate. Native VC authentication
is preserved. Maintenance cancels SSE subscriptions and waits for accepted finite requests.

Upstream client and clock ports in the private runtime manifest are controller internals. Direct
concurrent writes to them bypass admission tracking and are unsupported during checkpointing. Remote
signers and external validator key paths are rejected. Use isolated networks with disposable
development keys, never live validator keys.
