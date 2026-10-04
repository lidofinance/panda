# Stop and resume

Controlled Gloas networks with bakes declaring `checkpointAbi: 1` support a clean stop and cold
resume. Historical bakes without that capability cannot produce a verified checkpoint. Snapshot
implementation and its remaining acceptance gates are tracked in the
[snapshot plan](snapshots-plan.md). Dynamic schedules are separate work in the
[hardfork transition plan](hardforks-plan.md).

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
ordinary `up`/`open` foreground controller's Ctrl-C retain destructive semantics for active runtime
data. The recovery entrypoints below preserve their state on SIGTERM.

```sh
deno run -A src/cli.ts stop
deno run -A src/cli.ts lifecycle
deno run -A src/cli.ts resume
```

`Devnet.open(config)` and `deno run -A src/cli.ts open --profile gloas --bake local` open an
existing clean checkpoint when there is no current owning controller. They never create fresh
genesis as a fallback. Use the same ID, configuration, exact bake and native platform.

## Snapshot development API

The current implementation supports create, list, live restore, remove, operation lookup and offline
startup. Interrupted-copy cleanup, complete crash-stage coverage and the protocol release gates are
still open; see the snapshot plan before treating this as a released feature.

```ts
const snapshot = await net.createSnapshot(); // Healthy network at a completed slot tail.
await net.advanceSlots(10);
await net.restoreSnapshot(snapshot);
console.log(await net.listSnapshots());
await net.removeSnapshot(snapshot); // Deletes the archive; the restored network keeps running.
```

Creation resumes the source at the same time and restores its automine setting. Restore returns to
the saved time with automine off, replaces the active generation and retains the archive for reuse.
It cancels work from the discarded branch and can recover after a detected advancement/client
failure. The public URLs remain stable; restart external waits, filters, subscriptions and consumer
caches. Oracle/indexer databases are outside Panda's snapshot.

For a stopped owner, including after owning `close()` removed its runtime:

```ts
await using restored = await Devnet.fromSnapshot(snapshot, { id: "resume-example" });
```

The stored configuration and exact bake are authoritative. This factory takes an owner ID, not chain
overrides. A second live owner is refused. `close()` removes only the active runtime; the snapshot
remains in the owner's persistent directory.

```sh
PANDA_ID=resume-example deno run -A src/cli.ts snapshot create
PANDA_ID=resume-example deno run -A src/cli.ts snapshot restore <snapshot-id>
PANDA_ID=resume-example deno run -A src/cli.ts snapshot list
PANDA_ID=resume-example deno run -A src/cli.ts snapshot open <snapshot-id>
PANDA_ID=resume-example deno run -A src/cli.ts snapshot remove <snapshot-id>
```

`snapshot open` starts an offline snapshot in a foreground controller. `recover` starts a foreground
recovery service for an existing unclean generation, without opening its databases. Both preserve
state on SIGTERM; use `down` for explicit destruction of the active runtime.

`snapshot list`, `snapshot operation` and `snapshot remove` also work without a live controller.
Removal is serialized with capture/restore, deletes only the selected archive, and retains a small
deletion record so interrupted deletion can finish safely. A removed ID cannot be recreated. A
terminal failed removal keeps its recorded error; retry with a new operation ID to finish cleanup.
An interrupted running removal can continue with the same operation ID.

Archive integrity covers file bytes, names, permissions, numeric ownership and empty directories.
Restore rejects changed metadata as well as changed database files. Snapshot storage is private and
contains disposable validator keys; keep it outside Git and ordinary CI evidence uploads.

SDK mutations accept `{ operationId: "<uuid>" }`; CLI mutations accept `--operation <uuid>`. An
operation ID identifies one request; the snapshot ID identifies the reusable archive. Replaying the
same operation returns its recorded outcome without another restore. Use a new operation ID for
another restore. After a lost response, inspect `snapshotOperation(id)` or
`snapshot operation <id>`; the SDK also attempts this read-only reconciliation. Interrupted requests
retain their stage and require an explicit new restore instead of silently repeating uncertain work.

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
next start exposes a recovery service with `ready: false` and `recoveryRequired: true`. It reports
the active generation, leaves protocol time unset and refuses ordinary client commands. List saved
snapshots and explicitly restore one through the same control API. It does not create fresh genesis
or silently roll back. The equivalent local entrypoint is `deno run -A src/cli.ts recover`.

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
