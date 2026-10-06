# Snapshot branch audit

Audit of `feat/snapshots-minimal` against `origin/main` (`0acee41`), October 6, 2026. Scope: the
Panda snapshot implementation, its lifecycle changes, consensus capture/replay and the Gloas
Lighthouse delta for bake `gloas/snapshot-minimal-r1`. Findings come from source review by the
implementing agent and three independent review subagents; items marked _confirmed_ were checked
against the code or reproduced with a probe. Status values: **open**, **fixed** (with its
regression), **accepted** (documented limitation, no code change).

Baseline checks before any fix: `deno task check` passed; `deno task test` passed 243, failed 0,
ignored 13. No Docker/devnet scenario was run by the audit itself.

## Release evidence

| ID | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Status   |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| E1 | `reports/profiles/gloas/snapshot-minimal-r1/verification.json` was `failed` and its suite hash no longer matched the registered scenarios: bake unverified. After the fixes, one complete profile run on the final tree passed all 17 scenarios (see Fix verification).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | fixed    |
| E2 | Shared lifecycle code changed for every profile without a Pectra profile run. Maintainer decision: only Gloas is developed, verified and released; Pectra is kept as history. CI and release plans now use `maintainedProfiles` and reject Pectra; Gloas is the default profile. Regressions: `tests/config_test.ts`, `tests/release_pr_test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | accepted |
| E3 | Linux AMD64 profile and packaged-service checks have not run (already stated as a release gate in the design document).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | open     |
| E4 | Commit `bb4bb57` ("Add comprehensive tests…") contains the whole runtime implementation; `0ea0c87` ("Add tests…") contains the Lighthouse patch. History misdescribes content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | open     |
| E5 | Pre-existing, also on `HEAD`: the `default` tags of both profiles (`pectra/default`, `gloas/default`) lack the clock environment namespace, so the default `deno task up` and `test:baker`'s rollback test fail before startup. With `PANDA_BAKE=ci-main-merge` (Pectra) or the Gloas snapshot bake the test passes. A maintained Gloas default tag is still needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | open     |
| E6 | Found by the post-fix profile run and fixed: the failure-safety release gate (`warp-economics`) failed on the branch because a faulted timeline also faulted ingress, so `status` and Beacon reads returned 503 after a deliberate signer failure. Its passing evidence predated the ingress code. Reads now stay available; every mutation still reports `reset required` and snapshots are refused. Regression: `tests/snapshot_public_test.ts` ("a faulted timeline keeps reads available…").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | fixed    |
| E7 | Found by a profile run; the race is in `main`'s Gloas direct-sync patch path. Lighthouse registers the SSE `head` event in `import_block` as soon as fork choice selects the block, but updates its cached head only later in `recompute_head_at_current_slot` (after the "Valid block from HTTP API" log). The VC signs sync votes on that event; the patch completes the `sync_contributions_<root>` barrier only while the votes' root is the cached head and never re-checks. After a restore and fast skip a cold state load delayed the head update by about 30 ms: the BN accepted the complete committee (218 validator/subnet pairs = 56+53+53+56) under the old head, and `stepSlot` waited `PANDA_TIMEOUT_MS` (1 hour). **Fixed in Panda without a client change:** the capture path holds a current-slot sync batch for a block of that slot until `GET /eth/v1/beacon/headers/head` (the same cached head) returns its root, bounded to 5 s, then forwards unchanged; a cancellation during the hold forwards nothing. Regressions: `tests/consensus_messages_test.ts`. Real runs logged the hold at slot 24576 (12-14 ms) and passed. | fixed    |

## High

**H1 — Any aborted non-GET request permanently faults ingress, including Pectra.** _Confirmed._
`src/controller.ts` `proxy()` treats every non-GET request as a mutation, so read-only JSON-RPC
(`eth_call`, `eth_blockNumber`) counts. A client disconnect or timeout aborts the upstream fetch via
`request.signal`, and both the fetch error path and the lost-response-body path call
`ingress.fault()`. Every later command and proxy call then returns 503. Recovery requires
create/resume/restore, which Pectra and non-snapshot Gloas bakes cannot perform; only `down`/`reset`
helps. `main` never faulted its EL proxy and woke automine only for transaction submissions.
**Status: fixed.** JSON-RPC is a write only for transaction submissions; Beacon query POSTs are
reads. Writes complete upstream after a client disconnect, and a lost body after response headers
changes nothing. A genuinely unknown outcome refuses snapshots for the branch instead of faulting
ingress. Regressions: `tests/snapshot_public_test.ts` (aborted read, disconnected submitter, lost
body, undeliverable submission on Pectra and Gloas, interrupted and stalled uploads, Beacon query).

**H2 — A submission refused by Panda's own parser faults the session although nothing reached the
BN.** _Confirmed by probe._ `src/consensus_messages.ts` throws before forwarding for unsupported
encodings (SSZ attestation/sync, numeric integers, missing content type, `content-encoding`) and for
capture capacity. The proxy reports it as "Submission outcome is uncertain" and faults ingress.
Lighthouse would have answered 400. The design says unsupported encodings only prevent capture and
capacity refuses admission. **Status: fixed.** Refusals before forwarding raise
`ConsensusAdmissionError` and return 400/415/503 without faulting ingress or refusing snapshots.
Regression: `tests/consensus_ingress_test.ts` ("submissions refused before forwarding…").

## Medium

**M1 — A failed fresh start leaves a faulted generation that blocks the next `up`.** _Confirmed._
`Network.startOwned` creates the active generation before client startup and its catch only marks it
faulted; `Controller.open` does the same for a later failure. The next `up` enters recovery, which
throws "Recovery requires the exact snapshot-capable bake" on Pectra. `main` destroyed a failed
start. **Status: fixed.** `Network.abandonStart()` removes a failed fresh genesis (no checkpoint,
not a restore candidate) from both startup paths; resumed and candidate data stay as evidence.
Regressions: `tests/startup_cleanup_test.ts`; Docker rollback test in `tests/docker_test.ts`.

**M2 — Ctrl-C/SIGTERM in an unsafe cut makes explicit recovery mandatory.** `closePreserving` marks
the generation faulted whenever preservation fails, including ordinary states such as a pending
transaction, a mid-slot `advanceTime` or an earlier untracked write. The next start requires a
snapshot restore or `reset`. **Status: accepted.** Panda must not secretly advance time or discard a
live chain; the limitation is now stated in `docs/snapshots.md`. Automine is no longer re-armed
during this teardown.

**M3 — `down` after a restore that failed before commit does nothing.** `Network.stop()` returns
early when a candidate is set and its lock was already released by `fail()`. The faulted source
remains active and the next `reset` lands in recovery. **Status: fixed.** `Controller.close()`
removes the active network after abandoning a candidate, and always removes in `finally`.
Regression: `tests/startup_cleanup_test.ts`.

**M4 — `down` returns before the controller has finished and can preserve instead of destroy.**
`cli.ts down()` waits only for Docker resources; the `main` controller-lock wait was removed.
Generation destruction and owner release happen afterwards, so `reset` can race into "owned by live
process" or see the old `active.json`. A failure inside the controller's `close()` is only logged
there. During a Ctrl-C preserving shutdown, `shutdown` returns the existing preserving promise, so
`down` reports success while a stopped generation remains. **Status: fixed.** `down` waits for
`StateStore.ownerReleased()` and then completes removal itself; a `down` during a preserving
shutdown removes the network before ownership is released. Regressions:
`tests/startup_cleanup_test.ts`, `tests/storage_test.ts`, and `bakes/shared/tests/lifecycle.ts`
(`down` during Ctrl-C).

**M5 — The packaged service ignores the retained configuration.** `container/main.ts` calls
`recover`/`start` with default configuration instead of the retained one. A seeded network with
non-default validators, chain ID or quotients fails with a configuration mismatch on every restart.
**Status: fixed.** CLI and service share `Controller.launch()`, which resumes or recovers with the
retained configuration and refuses explicit profile/bake conflicts. Services without snapshot
support start from a fresh genesis as before. Regression: `tests/startup_cleanup_test.ts` ("startup
selection…").

**M6 — Interrupted imports and exports leak full copies, including validator keys.** _Confirmed._
`.pending-export-*` and `.pending-import-*` directories under `snapshots/` are never collected:
cleanup knows only `.pending-<createOperationId>` and `list()` hides them. **Status: fixed.** Taking
controller ownership sweeps them (`SnapshotStore.sweepTransfers()`), skipping foreign entries.
Regressions: `tests/snapshots_test.ts`, `tests/startup_cleanup_test.ts`.

## Low

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                | Status   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| L1  | A foreign entry such as `.DS_Store` or a non-UUID name in `snapshots/` makes `snapshotList` throw; a corrupt `manifest.json` breaks both `list()` and `remove()`. Journal listing has the same pattern. _Confirmed._ Fixed: listing and the operation journal skip foreign/hidden entries; removing a snapshot with a corrupt manifest remains manual. | fixed    |
| L2  | HTTPS import fails when the host sends `Content-Encoding: gzip`: Deno `fetch` decodes transparently and the SHA-256/format check fails closed.                                                                                                                                                                                                         | fixed    |
| L3  | Archive header validation accepts a numeric `createdAt`; `list()` sorting then throws for the whole owner. Fixed: exact reference fields and a string time are required.                                                                                                                                                                               | fixed    |
| L4  | Restore never reopens ingress when it fails before discarding the healthy source (drain, automine or journal write failure); create handles this case.                                                                                                                                                                                                 | fixed    |
| L5  | `createSnapshot` swallows `ingress.resume()` failures in an empty `catch {}`. Fixed: refusals are logged as `ingress-reopen-refused`.                                                                                                                                                                                                                  | fixed    |
| L6  | Every EL POST, including reads, wakes automine (`txpool_content` scan per call); `main` woke only for transaction submissions. Fixed, including `eth_sendRawTransactionSync`.                                                                                                                                                                          | fixed    |
| L7  | `close()` no longer runs `network.stop()` in `finally`; an error from `closeServers` leaves containers running.                                                                                                                                                                                                                                        | fixed    |
| L8  | Any non-200 consensus response permanently disables snapshots for the branch, including unambiguous full rejections. Intentional fail-closed behavior.                                                                                                                                                                                                 | accepted |
| L9  | A transient index-lookup transport failure after bootstrap faults the timeline instead of waiting for the next successful lookup.                                                                                                                                                                                                                      | open     |
| L10 | Importing or deleting a key of an already-active validator can make the equal-count PTC readiness wait until `PANDA_TIMEOUT_MS` (1 hour default), then fault the timeline. Plausible; not reproduced.                                                                                                                                                  | open     |
| L11 | `beforeDrain` (`automine.set(false)`, `time.queue.idle()`) runs outside the drain deadline; create/restore during a long warp waits without a bound.                                                                                                                                                                                                   | open     |
| L12 | Automine is not restored after stop/resume or a process restart; undocumented.                                                                                                                                                                                                                                                                         | open     |
| L13 | `lifecycle()` reports the candidate's generation after a failed pre-commit restore.                                                                                                                                                                                                                                                                    | open     |
| L14 | The final journal write failing (`ENOSPC`) can leave a succeeded operation `running`; a retry then reports it failed. Plausible.                                                                                                                                                                                                                       | open     |
| L15 | Cleanup errors in import/export replace the original failure.                                                                                                                                                                                                                                                                                          | open     |
| L16 | HTTPS import has only a whole-transfer deadline; a stalled server holds `snapshots.lock` and controller ownership up to `PANDA_TIMEOUT_MS`. HTTP export builds the whole archive inside `reserve()`, blocking lifecycle work meanwhile.                                                                                                                | open     |
| L17 | Lock contention on `snapshots.lock`/`snapshot-operation.lock` reports "owned by live process"; a cross-process retry of the same operation ID gets that error instead of the recorded outcome.                                                                                                                                                         | open     |
| L18 | A seeded startup's random restore operation ID remains `running` forever after a crash.                                                                                                                                                                                                                                                                | open     |
| L19 | The private relay matches captured routes by exact path; a trailing-slash alias could bypass capture if the Beacon router accepts it. Plausible; the public route rejects aliases.                                                                                                                                                                     | open     |
| L20 | Different accepted PTC messages for one validator and slot have no ambiguity identity. Lighthouse should reject the duplicate (which already disables snapshots). Untested.                                                                                                                                                                            | open     |

| L21 | Added by the fix review and fixed: a stalled or interrupted EL upload kept its lease or |
L22 | Added by the second fix review and fixed: Ctrl-C during a snapshot job that failed before
touching the source left ingress faulted, so the stop became unclean. Shutdown now reopens ingress
without re-arming automine. Regression: `tests/snapshot_controller_test.ts`. | fixed | | L23 | An
abort after a consensus upload but before forwarding refused snapshots although nothing was
forwarded; it is now an admission refusal. | fixed | | L24 | `eth_sendRawTransactionSync` waits for
its receipt before automine is notified, so with automine each call can last until Geth's sync
timeout and drain waits for it. Pre-existing interaction. | open | | L25 | Startup cleanup errors in
`abandonStart` replace the original startup error. | open | refused snapshots; an aborted start
skipped removal when `fail()` threw; a foreign `.pending-export-*` file blocked startup; `launch`
advised `reset` while a live controller owned the id. | fixed |

## API and documentation

| ID | Finding                                                                                                                        | Status |
| -- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| D1 | `docs/snapshots.md` shows `snapshotCreate` with a required `[operationId]`; code and the generated reference make it optional. | fixed  |
| D2 | OpenAPI: the archive 200 response description repeats the `snapshotOperation` text.                                            | fixed  |
| D3 | An unknown snapshot ID returns 500 (or 503 while unready), not 404; a busy lifecycle returns 500.                              | open   |
| D4 | The `/vc/` and `/cl/` proxy prefixes are undocumented.                                                                         | open   |

Endpoints present: `POST /control` with `snapshotCreate`, `snapshotList`, `snapshotRestore`,
`snapshotRemove`, `snapshotOperation`, `lifecycle`, `stop`, `resume`; `GET /lifecycle`;
`GET /snapshots/{id}/archive`. Import is startup-only (`--snapshot`, `PANDA_SNAPSHOT`) by design.

## Lighthouse delta

The runtime change touches three existing files and preserves upstream behavior outside controlled
mode; signing, verification and target selection are unchanged. `ptc_wait` is required: the existing
`payload_attestations` mark is set concurrently with loop re-entry and does not prove the next
target was selected.

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| LH1 | The published "+23/-2" excludes test hooks injected into production files: inline `#[cfg(test)]` calls in two runtime functions, two appended static/function blocks and two `include!` lines. Counting them gives about +46/-2 (+27/-2 in function bodies). Fixed in documentation: the design document now states both counts.                                                                                                                                                                                          | fixed    |
| LH2 | In controlled mode, `wait_for_attestation_slot` returns `None` from `start_of`/`checked_add`/`instant_at` without sleeping; the service loop would spin. Upstream `None` paths sleep one slot. Unreachable in practice (overflow or non-UTF-8 env value). Not reachable from Panda: the clock variable is set only by Panda itself (`src/network.ts`, at startup and on fast-warp VC replacement) to an integer millisecond timestamp, and protocol slots stay far from u64 overflow. Fix at the next Lighthouse rebuild. | accepted |
| LH3 | `tests/panda_ptc_deadline.rs` re-includes the whole `lib.rs` to expose unit tests as a named target, and the test rig gains an unconditional `include!` of a mock fixture. Test-only, but unusual.                                                                                                                                                                                                                                                                                                                        | accepted |

## Cleanliness

Not defects; recorded for follow-up refactoring.

- The UUID regex is duplicated four times, plus `syncDirectory`, free-space and image-identity
  helpers and the 12 000/11 500 ms tail arithmetic.
- `createSnapshot` duplicates `preserveSession` and tracks four flags; `startOwned` is about 320
  lines. `adopt(await Controller.open(new Network(config), "resume"))` appears three times.
- `Checkpoint` aliases `SavedState` and clashes with finality checkpoints; the CLI validates
  snapshot IDs with `operationId` and reports the wrong noun.
- A restore hashes the whole snapshot about four times; startup from a file about six.

## Untested edge cases found by the audit

Aborted read-only POSTs and parser-refused submissions; Pectra failed start followed by `up`;
`down`/`reset` after a failed restore and during Ctrl-C; Ctrl-C in an unsafe cut; packaged restart
with a non-default seed configuration; process kill during import/export; foreign/corrupt store
entries; HTTPS `Content-Encoding`, stalled server and HTTPS size limit; SIGINT during restore or
seeded startup; active-key import/delete versus PTC readiness; conflicting PTC contents.

## Coverage added after the audit

| ID | Gap                                                                                                | Added check                                                                                                                                                                         |
| -- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | After restore only the contract storage value was compared; the contract was never executed again. | `assertContractWorks` (`bakes/gloas/tests/snapshots.ts`): code equals the deployed runtime, `eth_call` reads the saved value and the first post-restore block executes a new write. |
| C2 | A network started from an exported archive executed a contract write but never checked its effect. | `snapshot-external` uses the same check and verifies the write survives a clean restart.                                                                                            |
| C3 | Nothing exercised a restored network across a sync-committee period or VC replacement.             | `snapshots`: after the restores, a fast 8192-slot warp, a contract write and resumed finality.                                                                                      |
| C4 | The registered suite compared cold restoration with an uninterrupted reference only at slot 3.     | `snapshot-replay` now compares slots 3, 31 and 32 (both sides of the first epoch boundary).                                                                                         |
| C5 | The complete cut matrix had last run before the ingress code existed.                              | Rerun explicitly on the final tree: cuts 0, 3, 31, 32, 127, 128 and sparse 35 matched the uninterrupted reference through slot 226 with no differences.                             |

## Fix verification

All results below are from executed commands on the final working tree (Linux ARM64 clients under
Docker Desktop on macOS ARM64). The bake was not rebuilt: `gloas/snapshot-minimal-r1`, key
`89bb12c9…8d61`.

| Check                                                                  | Result                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `deno task check`                                                      | passed                                                                          |
| `deno task test`                                                       | 273 passed, 0 failed, 13 ignored                                                |
| `deno task test:baker`                                                 | 3 passed, 1 failed: pre-existing E5 (also on `HEAD`)                            |
| `PANDA_DOCKER_TEST=1 deno test tests/docker_test.ts` with a valid bake | 2 passed (Pectra `ci-main-merge`), rollback passed (Gloas)                      |
| `deno task test:profile gloas --bake snapshot-minimal-r1`              | **passed, 17/17 scenarios, 26 min**, suite `454ed9d9…`; the E7 hold fired twice |
| Packaged service (`package_image.ts`, `docker build`, `test_image.ts`) | passed, 56.7 s                                                                  |

Five extra `snapshot-withdrawals` runs after the E7 fix passed, with the sync hold logged 8 times at
slot 24576. The cut matrix (C5) ran explicitly before the final profile run. The first post-fix
profile run stopped at the pre-existing `warp-economics` failure-safety regression (E6); it was
fixed with a failing unit regression first and the whole profile was rerun from the start. Every new
behavior above has a regression that failed before its fix; red logs are kept privately under
`.cache/audit-fixes/`. Pectra profile runs were intentionally not performed (E2). Linux AMD64 (E3)
and the commit history (E4) remain open.
