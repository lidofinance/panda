# Snapshot acceptance and verification

Recorded October 4, 2026. **P0–P5, snapshot P9 and P10 are complete and accepted locally on
Gloas/Linux ARM64. The full current profile passed 19/19 with no failures in 1,975.949 seconds.**
The [snapshot plan](snapshots-plan.md) owns the acceptance criteria; [lifecycle](lifecycle.md)
documents the public API and recovery behavior. Dynamic hardfork transitions are separate work.

## Build and scope

| Input         | Identity                                                                             |
| ------------- | ------------------------------------------------------------------------------------ |
| Bake          | [`gloas/p3-checkpoint-r5`](../bakes/gloas/tags/p3-checkpoint-r5.json)                |
| Bake key      | `24026a9da94b51171f1d67f810de97add9a15d4b06891ee6e2ceed5457248a53`                   |
| Lighthouse    | 8.2.2, `2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`, baker 3                           |
| Geth          | `5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186`                                           |
| CL image      | `sha256:940bf27d9dbfaa772a424035f0a3d93c1d39757feb75b6a5da7539420ce01224`            |
| EL image      | `sha256:b882c20ed0c3f59aa6b253fe94f56e33266f4c43720c41d064e127355b4b2208`            |
| Genesis image | `sha256:95d66723fab247e476861b7168e8b20150e85daeee734f2417a79c2db8e2b1a3`            |
| Platform      | macOS ARM64 host, Linux ARM64 clients, Docker Desktop Engine 29.8.1                  |
| Runtime       | Deno 2.9.7; Docker VM 6 CPUs and 8,320,028,672 bytes RAM                             |
| Format        | Snapshot schema 1, native checkpoint ABI 1                                           |
| Schedule      | Pinned Gloas active from genesis; mainnet timing, 12-second slots and 32-slot epochs |

The default fixture has 64 disposable validators. The consolidation/exit fixture explicitly uses
churn quotients of 4 while retaining mainnet eligibility and withdrawal delays. Each snapshot binds
its complete original configuration and cannot change the schedule. All P4–P10 work reused these
client images; it did not compile Geth or Lighthouse again.

## Commands and evidence

| Gate                                                   | Result                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `deno task check`                                      | Passed on the frozen executable tree; final documentation formatting also passed.                      |
| `deno task test`                                       | 311 passed, 122 nested checks, 0 failed, 23 opt-in scenarios ignored; 72 s.                            |
| `deno task test:baker`                                 | 4 passed, 0 failed; 29 s. Image reuse/archive recovery, startup rollback and other-owner preservation. |
| `deno task test:profile gloas --bake p3-checkpoint-r5` | 19 passed, 0 failed; 1,975.949 s. Run `8316eab3-3db9-4e11-b8c5-b038b84762f1`.                          |
| Packaged service                                       | Separate fixed-image run passed in 117.88 s; current runtime and test source hashes match.             |

The full profile is bound to suite fingerprint
`adbcaa27d5111209db8f1521364f04a42e32b6769f7e2e1b9e60b3e3fd109449`. Its runner checks that sources
and bake did not change during execution and that every scenario report belongs to the same run and
bake. It completed successfully at **14:11:19 UTC**. A separate final readback matched the current
suite hash, bake and all 19 report run IDs. Historical 13-scenario and standalone results were not
combined to produce this pass. See the
[verification record](../reports/profiles/gloas/p3-checkpoint-r5/verification.json).

Read-only Docker inspection found **zero remaining containers, networks or volumes** belonging to
the 25 owners recorded by this run. No global cleanup was used.

The [packaged result](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-container.json) records
image `panda-ci-gloas:p5.2`, ID
`sha256:b1fb5459293d634d60dde0af55873f1c199f0ce13026af73b8e17a30b159571e`. Final readback compared
all 43 recorded package files against their context, all repository-owned files against the current
tree, and the test script hash: all matched. `release.json` is generated package metadata and was
checked in its build context. This is a local worktree image, not a published release.

## Requirement audit

The rows below map the original contracts to implemented and executed tests. The full current
profile passed all 19 scenarios. Unit/adapter fault injections and native tests are identified
explicitly rather than presented as real-client scenarios.

| Contract                                                                                           | Evidence                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save only a healthy completed cut; no hidden blocks or time advance                                | `controller_lifecycle_test.ts`, managed resume guards and real snapshot state equality.                                                                                      |
| Drain managed EL/CL/VC, reject unresolved transactions, preserve native protocol pools             | P0–P3 admission/native evidence plus the full profile's `resume` and `restart` scenarios; pending real signed exit in `snapshot-withdrawals`.                                |
| Immutable, independent copy with exact config, bake, images, keys, metadata and checksums          | `snapshots_test.ts`, `generation_copy_test.ts`, full readback before publication/preparation and independent contract storage/receipt/Beacon SSZ in `snapshots`.             |
| Copy/persistence failure cannot publish a partial archive or destroy the source                    | Controller/storage injections, seven manifest/publication failures and eight real SIGKILL creation cuts in `snapshot-creation`.                                              |
| A published archive survives failed source resume and owning close                                 | Structured partial-failure controller/API tests; real snapshot reuse after runtime destruction.                                                                              |
| Restore validates bytes, metadata, compatibility and capacity before stopping a working source     | Storage/controller tests; the capacity test injects an oversized verified inventory rather than filling the host disk.                                                       |
| Old signers stop; candidates start parked; verified commit determines authority                    | `snapshot_network_test.ts`, controller tests and 11 real restore/copy/cleanup SIGKILL cuts in `snapshot-recovery`.                                                           |
| No rollback after commit; same request is not executed twice; unknown HTTP outcome stays queryable | Journal/API/controller regressions, process-loss stages and packaged restore request replay.                                                                                 |
| Repeated, faulted and offline restore preserve exact state and continue normally                   | `snapshots`: live/repeated/killed-BN/offline restore, independent EVM storage, full prior receipt, full Beacon SSZ, signing history, next PTC/transaction and real finality. |
| Inactive data and interrupted deletions are cleaned without touching active/foreign data           | `snapshot_cleanup_test.ts`, source-authority fsync regressions, real partial-copy/unlink cuts and exact-owner Docker/baker checks.                                           |
| SDK/CLI entrypoints, stable URLs, session cancellation and lifecycle ownership                     | API/CLI/session tests, real lifecycle/offline recovery and the packaged service's same SDK/ports across container replacement.                                               |
| Retained `/data/panda` survives loss of the entire service container                               | Packaged SIGKILL → replacement → recovery-required without clients/genesis → explicit restore → next transaction/finality.                                                   |
| Deposit and activation queues replay once                                                          | `snapshot-deposits`: pending deposit at slot 2 and pending activation at slot 224; original and restored branches activate one validator and retain 65 signing records.      |
| Consolidation, exit and payouts preserve queues and real economics                                 | `snapshot-withdrawals`: pending consolidation and signed exit, exact saved state, one exit inclusion, unique withdrawal indices, actual EL credits and final exited balance. |
| External consumer state is reset explicitly and earlier history survives replay                    | `snapshot-consumer`: separate process/database and EL/CL cursors, demonstrably stale nonce cache, reset/replay from genesis, preserved past and removed future.              |
| Verification is bound to current source and profile                                                | Registration and fingerprint regressions include crash/consumer child processes; full profile checks its final suite hash and per-report run IDs.                            |

Native persistence, real BLS/KZG validation, candidate key validation and the independent
uninterrupted-network reference are documented in the [P0–P3 audit](snapshots-p0-p3-status.md). No
new native patch was required by the archive/restore implementation.

## Fixed snapshot findings

| Reproduced defect                                                                  | Correction and verification                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost-response reconciliation could accept another request's result                 | Check operation ID and payload; regression passed.                                                                                                                                             |
| Interrupted creation queried a nonexistent live session in recovery                | Reconcile the durable archive/journal directly; unpublished and published cases passed.                                                                                                        |
| A killed pre-commit controller left candidate containers blocking recovery         | Explicit restore/down remove every exact-owner runtime under its lock; real separate repeat and foreign-owner tests passed.                                                                    |
| Partial copies and discarded branches remained after cleanup                       | Journal allocation before mkdir; retry inactive/pending deletion; real copy/rename/unlink cuts passed.                                                                                         |
| `down` could delete resources before obtaining journal ownership                   | Acquire that lock first; refusal regression passed.                                                                                                                                            |
| A visible pointer rename could retire old files before durability was confirmed    | Sync active authority before cleanup; persistent sync failure preserves old data and reports cleanup failure.                                                                                  |
| A killed packaged Geth left an IPC socket that blocked obsolete-generation cleanup | Permit Unix sockets only for journaled inactive deletion after container/authority checks. Archive validation remains strict; focused RED/GREEN and a separate fixed-image package run passed. |

Final source review follows startup, validation, commit, response loss, process loss, cleanup and
shutdown, and checks the corresponding executed tests. No unresolved snapshot implementation finding
remains. All six snapshot scenarios passed in the final full run: state/reuse **91.70 s**, 11
recovery cuts **327.75 s**, eight creation cuts **321.62 s**, deposit/activation **154.22 s**,
consolidation/exit/payout **133.61 s**, and external consumer reset/replay **36.63 s**.

## Measurements and limits

The [snapshot scenario](../reports/profiles/gloas/p3-checkpoint-r5/snapshots.json) passed in the
completed full run in **91.70 s**.

| Measurement                                    | Observed value                                        |
| ---------------------------------------------- | ----------------------------------------------------- |
| Capture API call                               | 17.10 s                                               |
| Restore API calls: live / repeated / failed BN | 12.20 / 13.24 / 13.31 s                               |
| First transaction after restore                | 143 ms                                                |
| Archive file bytes                             | 11,681,239                                            |
| Archive allocated bytes                        | 13,877,248                                            |
| Whole owner before / after capture             | 25,415,680 / 26,275,840 allocated bytes               |
| Net retained change after capture              | +860,160 allocated bytes                              |
| Whole owner after the three restores           | 26,259,456 / 26,374,144 / 26,484,736 allocated bytes  |
| Whole owner after archive removal              | 12,701,696 allocated bytes                            |
| Continued chain                                | Slot 128, real finalized epoch 2 with EL/CL agreement |

Times are end-to-end API latency, an upper bound on maintenance, not a separately measured exact
HTTP outage interval. Allocated bytes come from `du -sk` at each cut. The whole-owner delta includes
database and log changes during clean stop/resume and is not the archive's storage cost or a free
space recommendation. Shared filesystem extents may be counted per file. Transient peak disk usage
is not measured. This snapshot included nonzero EVM storage, a full prior receipt and independently
captured Beacon SSZ, all compared after source resume and each restored branch.

The separate packaged-service run measured restore at **9.49 s** and the next transaction at **111
ms**, then real finality at epoch **8**. These are observations on one host, not portable
performance guarantees.

Acceptance is limited to controlled Gloas and this Linux ARM64 bake. AMD64/GitHub CI publication,
Pectra, baseline snapshots, remote signers, external validator ownership, cross-host archive
import/export, arbitrary database migrations and dynamic hardfork transitions are outside this
result. An unclean active directory is not automatically resumable; recovery needs a previously
saved compatible snapshot.

The committed Gloas release lock still selects an older published bake without `checkpointAbi`
(baker 1). It does not contain this snapshot capability. To publish the feature, first run **Publish
Lighthouse images** for the current baker 3 inputs and merge its generated release PR; Panda
publication then runs the current full profile and packaged-service checks on AMD64. A
controller-only tag using the old lock cannot provide snapshots. This task neither changes that
immutable lock to a local ARM image nor publishes a release.

Original private logs and fixture data stay in ignored `.cache/` and `.panda/`. Public reports omit
personal checkout paths and unrelated Docker workload identities. Snapshot directories contain
private validator material and are not uploaded as ordinary CI evidence.
