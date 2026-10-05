# Snapshots

A Panda snapshot saves the complete local network: Geth and Beacon databases, validator keys and
signing history, protocol time, and the signed consensus messages needed after restart. Restore
returns to that saved slot without producing an extra block. The same snapshot can be restored
repeatedly until you delete it.

Snapshots require **controlled Gloas** and a bake with the PTC readiness fixes. In this checkout,
use `gloas/snapshot-minimal-r1`. This feature reaches published images when this branch is released;
existing `latest` images do not acquire it automatically.

## Local commands

Start Panda in one terminal:

```sh
deno task up --profile gloas --bake snapshot-minimal-r1
```

In another terminal, define a short command for the repository CLI:

```sh
panda() { deno run -A src/cli.ts "$@"; }
panda snapshot create
panda snapshot list
```

Copy the returned `id` into `SNAPSHOT_ID`, then use it as often as needed:

```sh
panda snapshot restore "$SNAPSHOT_ID"
panda snapshot export "$SNAPSHOT_ID" fixture.panda.gz
panda snapshot remove "$SNAPSHOT_ID"
```

The same commands are bundled in the Docker service: `docker exec panda panda snapshot create`. An
export made inside the service writes to the container filesystem; use a mounted output path or
`docker cp` to retrieve it. Export refuses to overwrite an existing file.

Creation briefly stops and resumes the source, preserving its automine setting. Restore turns
automine off and returns a new `sessionId`. API URLs stay the same. Reconnect subscriptions and
reset external providers, indexers and oracle caches after restoration; their state is not inside
Panda.

## HTTP

The [API reference](snapshots-api.md) and [OpenAPI specification](snapshots-openapi.json) are
generated from the snapshot wire types. Run `deno task docs:snapshots` after changing the contract;
`deno task check` verifies they are current.

Send commands to `POST /control`. Responses wrap successful values in `{"result": ...}`:

```sh
curl --fail-with-body http://127.0.0.1:8545/control \
  --json '{"method":"snapshotCreate","params":["c767e2b1-c056-4c58-bd22-3231c5613287"]}'
```

Choose a fresh UUID for each new mutation. Keep it to query or retry the same operation after a lost
response.

| Method              | Parameters                  | Result                                                               |
| ------------------- | --------------------------- | -------------------------------------------------------------------- |
| `snapshotCreate`    | `[operationId]`             | Snapshot ID, creation time, profile, bake key, saved time and head   |
| `snapshotList`      | `[]`                        | Saved snapshots                                                      |
| `snapshotRestore`   | `[snapshotId, operationId]` | Snapshot, generation, new session ID and saved time                  |
| `snapshotRemove`    | `[snapshotId, operationId]` | Removed snapshot                                                     |
| `snapshotOperation` | `[operationId]`             | Durable result, failure and cleanup status; absent for an unknown ID |

Download an archive with `GET /snapshots/<snapshotId>/archive`. Its `X-Panda-SHA256` response header
is the SHA-256 of the compressed file. For example:

```sh
curl --fail -D fixture.headers -o fixture.panda.gz \
  "http://127.0.0.1:8545/snapshots/$SNAPSHOT_ID/archive"
```

The CLI generates operation IDs by default. For a retryable script, pass your own and retain it:

```sh
panda snapshot create --operation "$OPERATION_ID"
panda snapshot operation "$OPERATION_ID"
```

Retrying the same completed operation returns its recorded outcome; it does not create another
snapshot or restore the network again. Reusing an operation ID for a different request is rejected.
Snapshot IDs and restore/remove operation IDs have different purposes.

## Start from a file or HTTPS

Use an unused `PANDA_ID` to start a separate network from an archive:

```sh
PANDA_ID=seeded deno task up --snapshot ./fixture.panda.gz
PANDA_ID=seeded deno task up --snapshot https://example.org/fixture.panda.gz --sha256 "$SHA256"
```

These are alternative startup commands. HTTPS must point to raw bytes, such as a GitHub Release
asset or raw-file URL. HTML pages and redirects to HTTP are rejected. The compressed and extracted
sizes are bounded; paths, file hashes and the exact bake, client image identities and architecture
are checked before activation. The required bake and its client images must be installed locally. A
snapshot cannot migrate between hardforks, incompatible client builds or architectures.

For a packaged image built from this branch, retain state in a named volume:

```sh
PANDA_IMAGE=panda-snapshots:local
docker run -d --name panda --privileged --stop-timeout 120 \
  -p 127.0.0.1:8545:8545 \
  -v panda-data:/data \
  "$PANDA_IMAGE"
```

After a release containing this feature, `PANDA_IMAGE` can be the corresponding published tag or
`ghcr.io/eddort/panda-gloas:latest`. Pin a digest when the fixture must stay reproducible.

To seed a fresh volume, add `-e PANDA_SNAPSHOT=https://example.org/fixture.panda.gz` and optionally
`-e PANDA_SNAPSHOT_SHA256="$SHA256"`. For a local file, mount it read-only and set
`PANDA_SNAPSHOT=/seed/fixture.panda.gz`. The service's default network ID is `service`; `PANDA_ID`
selects another owner within `/data`. Keep the same ID when reusing a volume.

An existing active generation takes precedence over the initial seed. A cleanly stopped network
resumes its own state; an unclean one requires explicit recovery. Startup never silently replaces
retained state by downloading the original seed again. Normal SIGTERM preserves the active network.
Allow enough stop time for client shutdown and database persistence. A forced kill cannot be treated
as a clean stop.

## What can be saved

Save at a completed slot tail, with no pending or queued execution transactions. `stepSlot`,
`advanceSlots`, and `advanceEpochs` end at suitable boundaries; an arbitrary mid-slot `advanceTime`
may not. Panda rejects an unsafe cut instead of secretly advancing time. State already queued in the
protocol, such as activation, consolidation or withdrawal work, is part of the saved databases.

The saved contract covers chain state, signing history, current duty/contribution queries and
subsequent consensus operations. Historical transient caches, metrics and open connections are not
preserved. In particular, a past-slot sync contribution may disappear after restart; current-slot
contribution queries are restored. Unsupported, future-slot or ambiguously accepted signed messages
prevent snapshot creation rather than being silently discarded. Direct block/envelope publication,
aggregate-and-proof or proposer-setting updates, and writes to the native validator API still reach
the client but disable snapshots for that branch. Use Panda's `importValidator` command for managed
key imports; after other unsupported writes, restore a completed snapshot or start a fresh network
before saving again.

Only the managed local clients and ingress are covered. Keep external validators and peers out of
this topology. Snapshots contain validator keys and passwords: share only disposable test-network
snapshots, and import artifacts from trusted sources. Checksums detect corruption; they do not
establish who created an archive.

## Failure and recovery

Panda validates and copies a restore candidate before stopping a healthy source. Damaged archives,
incompatible bakes and failed preparation leave that source running. If copying a new snapshot fails
after a clean stop, Panda attempts to resume the source and still reports the copy failure.

Once a snapshot is published, a later source-resume failure does not delete it. The failed operation
includes its `snapshot` reference. Query `snapshotOperation` or `panda snapshot operation` to
recover that ID. Cleanup has its own status and does not hide a successfully saved snapshot.

After a candidate becomes the active generation, a failure leaves it unready. Panda does not roll
back automatically after validators may have signed. Inspect `GET /lifecycle`, then explicitly
restore a completed snapshot using a **new operation ID**. An interrupted operation is not silently
repeated on restart.

Local Ctrl-C and container SIGTERM preserve clean active state. `deno task down` removes the active
network; completed snapshots remain. `reset` starts a fresh active network. Removing the `/data`
volume or the local Panda data directory removes those retained snapshots too.
