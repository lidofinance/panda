# Snapshots and lifecycle

Controlled Gloas networks with bakes declaring `checkpointAbi: 1` support a clean stop and cold
resume and reusable snapshots. Historical bakes without that capability cannot produce a verified
checkpoint. Local Gloas/Linux ARM64 acceptance is recorded in the
[verification report](snapshots-verification.md) and [snapshot plan](snapshots-plan.md). Dynamic
schedules are separate work in the [hardfork transition plan](hardforks-plan.md).

## Local Deno controller

For a running Docker service, use the
[HTTP snapshot and lifecycle commands](http-api.md#snapshots-and-lifecycle). The examples below use
the internal Deno client for local Panda development and tests.

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

## Snapshot API

The current implementation supports create, list, live restore, remove, operation lookup and offline
startup. Journal-scoped cleanup, real controller crash checks and persistent packaged-container
replacement have passed locally on Gloas/Linux ARM64. Protocol queue/payout and external consumer
fixtures have also passed, including the complete 19-scenario profile. This is verified local
functionality; an older published image without checkpoint ABI 1 does not acquire it automatically.
See [release requirements](ci-containers.md#first-publication-and-client-updates) before choosing an
image.

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

`snapshot list`, `snapshot operation`, `snapshot export` and `snapshot remove` also work without a
live controller. Removal is serialized with capture/restore, deletes only the selected archive, and
retains a small deletion record so interrupted deletion can finish safely. A removed ID cannot be
recreated. A terminal failed removal keeps its recorded error; retry with a new operation ID to
finish cleanup. An interrupted running removal can continue with the same operation ID.

## External snapshots: local files and HTTPS

Export a saved snapshot to a portable file. The SDK downloads it through Panda's HTTP API; the
destination path belongs to the SDK caller. The controller never assumes it can write to a client's
filesystem. Export does not stop clients or move protocol time, and it refuses to replace an
existing output file.

```ts
const snapshot = await net.createSnapshot();
const file = await net.exportSnapshot(snapshot, "./ready.panda-snapshot.gz");
console.log(file.sha256, file.bytes);

await using local = await Devnet.fromSnapshot(file.path, {
  id: "local-fixture",
  sha256: file.sha256,
});

await using remote = await Devnet.fromSnapshot(
  "https://github.com/OWNER/REPO/releases/download/FIXTURE_TAG/ready.panda-snapshot.gz",
  { id: "remote-fixture", sha256: file.sha256 },
);
```

Publish the exported file as a Release asset yourself and substitute its direct download URL. Public
HTTPS URLs and up to five HTTPS redirects are supported; HTML `blob` pages, HTTP downgrades, URL
credentials and private-repository authentication are refused or unsupported. Pin `sha256` in CI to
prevent an unexpectedly replaced asset from being used. Only import trusted test fixtures: these
archives include validator keys, signing history and native client databases.

The destination owner must have **no active generation**. Import creates its own immutable copy and
then uses the normal verified restore pipeline. The original file and source owner stay unchanged.
Configuration comes from the archive; ports and Docker resources belong to the new owner. Automine
starts disabled. Existing external indexer/oracle databases still need their own reset/replay.

The exact checkpoint-capable bake key, client image IDs and platform must already be installed.
Panda finds a matching local bake, or accepts an explicit equivalent `bake` tag. A different label
for identical images is fine; a different platform, client version or patch is rejected. Startup
does not build clients, import arbitrary database dumps or migrate between client versions.

```sh
PANDA_ID=source deno run -A src/cli.ts snapshot export SNAPSHOT_ID ./ready.panda-snapshot.gz
PANDA_ID=copy deno run -A src/cli.ts snapshot open ./ready.panda-snapshot.gz
PANDA_ID=ci-copy deno run -A src/cli.ts snapshot open \
  https://github.com/OWNER/REPO/releases/download/FIXTURE_TAG/ready.panda-snapshot.gz \
  --sha256 SHA256_FROM_EXPORT
```

For a packaged service, mount a local archive read-only and set `PANDA_SNAPSHOT`, or set it to an
HTTPS asset URL. `PANDA_SNAPSHOT_SHA256` is optional but recommended:

```sh
docker run --rm --privileged \
  -p 127.0.0.1:8545:8545 -p 127.0.0.1:5052:5052 -p 127.0.0.1:5062:5062 \
  -v panda-fixture-data:/data/panda \
  -v "$PWD/ready.panda-snapshot.gz:/fixtures/ready.gz:ro" \
  -e PANDA_SNAPSHOT=/fixtures/ready.gz \
  -e PANDA_SNAPSHOT_SHA256=SHA256_FROM_EXPORT \
  CHECKPOINT_CAPABLE_PANDA_IMAGE
```

The packaged bake must match the archive. The seed applies only when the persistent volume has no
active generation. A normal restart resumes the current state; unclean state enters recovery.
Neither case silently imports the original seed again. Choose a different volume to start another
independent fixture.

The format is versioned gzip with a canonical header and streaming SHA-256-checked files. Import
rejects unsafe paths, links, special files, invalid lengths, trailing data and incompatible
checkpoints before starting clients. Numeric ownership is recreated locally. The default limits are
8 GiB for the compressed file and 8 GiB unpacked, with a 16 MiB header; the SDK's `maxBytes` option
changes the import byte limits. Network/transfer watchdogs use `PANDA_TIMEOUT_MS` (one hour by
default). Reserve space for the compressed download, unpacked archive and restored copy. Interrupted
transfers do not publish partial snapshots; process-loss `.pending-*` remnants are hidden from
snapshot listing. Reimporting the same file reuses its verified local archive. A removed archive ID
stays retired: use another owner if that fixture is needed again.

Archive integrity covers file bytes, names, permissions, numeric ownership and empty directories.
Restore rejects changed metadata as well as changed database files. Snapshot storage is private and
contains disposable validator keys; keep it outside Git and ordinary CI evidence uploads.
Compatibility requires the same owner, exact bake/image IDs, native platform and configuration,
including the immutable fork schedule. Baseline mode, remote signers, cross-host archive transport
and database migrations are outside this API. Never combine signed histories from different restored
branches or copy their keys into another running network.

SDK mutations accept `{ operationId: "<uuid>" }`; CLI mutations accept `--operation <uuid>`. An
operation ID identifies one request; the snapshot ID identifies the reusable archive. Replaying the
same operation returns its recorded outcome without another restore. Use a new operation ID for
another restore. After a lost response, inspect `snapshotOperation(id)` or
`snapshot operation <id>`; the SDK also attempts this read-only reconciliation. Interrupted requests
retain their stage and require an explicit new restore instead of silently repeating uncertain work.

Create and restore record temporary generation IDs before allocating their directories. Once the
operation settles, cleanup removes only recorded inactive generations and unpublished pending
archives. It preserves active data, saved snapshots, unrecorded directories and generations still
attached to a client container. Deletion can resume after an interrupted rename or partial unlink.
Cleanup has a separate `cleanup` outcome in the operation record and `lifecycle()`: its failure does
not roll back a successful restore. A later create/restore or explicit `down` retries retained work.
Cleanup confirms the active pointer's durability before deleting old generations. If its sync fails,
the old data is retained; observing a renamed pointer alone does not authorize deletion. Cleanup can
remove Unix sockets left by crashed clients in verified inactive generations. Snapshots still reject
sockets and symlinks; deletion never admits a live/attached generation.

Common refusals and recovery steps:

| Result                                             | Meaning and next step                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed slot tail required                       | Finish the intended slot with `stepSlot()` before capture. Panda does not advance time to make a save succeed.                                       |
| Pending, queued or unresolved EL submission        | Resolve the submitted transaction on the current branch before saving. An empty txpool alone cannot settle an unknown submission.                    |
| Snapshot integrity/configuration/platform mismatch | Use the original compatible artifact and bake; a refused preflight leaves a working source available.                                                |
| Insufficient space to prepare restore              | Free storage before retrying. Preparation does not overwrite active databases.                                                                       |
| `SnapshotOperationError` with `operation.snapshot` | A failed capture may still have published a valid archive. Inspect the recorded stage and lifecycle before deciding whether to use it.               |
| `SnapshotRequestError`                             | The HTTP outcome is unknown. Query `snapshotOperation(error.operationId)` before sending another mutation.                                           |
| `recoveryRequired: true`                           | The active files are not a verified clean checkpoint. Explicitly select a saved snapshot; Panda does not silently choose one.                        |
| `cleanup.state === "failed"`                       | The operation and cleanup have separate outcomes. Keep the authoritative branch; a later create/restore or explicit `down` retries recorded cleanup. |

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

## Resetting an external consumer

Panda restores its EL/CL/VC state. A consumer's database, scan cursor, provider cache and
transaction nonce manager belong to that consumer. Stop its writes before restore, then explicitly
reset and replay it from genesis or its original deployment/start block. Replaying only from the
snapshot slot loses earlier history.

The executable [consumer scenario](../bakes/gloas/tests/snapshot_consumer.ts) uses a separate
process with its own persisted EL transaction and CL header history. Its
[fixture](../bakes/shared/tests/snapshot_consumer.ts) exposes this order directly:

```ts
await consumer.stop();
await net.restoreSnapshot(snapshot);
provider.destroy();
provider = new JsonRpcProvider(net.url);
signer = new NonceManager(new Wallet(testPrivateKey, provider));
await consumer.reset(); // Deletes only this stopped fixture's database and both scan cursors.
await consumer.start(); // New process and provider; replay begins at genesis.
await consumer.waitFor(await net.status());
```

Run the complete example against an existing checkpoint-capable Gloas bake:

```sh
PANDA_PROFILE=gloas PANDA_BAKE=<tag> deno run -A bakes/gloas/tests/snapshot_consumer.ts
```

The example proves that the external database still contains the discarded future immediately after
Panda restore. Reset/replay preserves its earlier records, removes that future and allows a new
transaction with the restored nonce. The fixture uses Panda's disposable chain ID 1337 and stores
its database outside Panda state, under ignored `.cache/snapshot-consumers/`. It is an integration
example, not an automatic reset mechanism for arbitrary oracle databases.

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
