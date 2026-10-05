# Snapshot design with a minimal Lighthouse delta

Proposal, October 5, 2026. Based on Panda `main` at `0acee414b7ab8921fe71e60055ad67faf87a15e8`,
compared with `feat/state` at `0d993d903a111730df9911afa0257c569cc3b722`. Gloas Lighthouse is pinned
to `2d281dfa1b407f7c81cd123954a9fd18ee8f02d2` in both revisions. The remote `main` commit was also
checked and matches this baseline.

Status: **stage 1 is complete** on `gloas/snapshot-minimal-r1` (Linux ARM64). Direct cold
save/restart/copied restore is verified using Panda's signed-message buffer and ordinary Beacon
APIs. The Lighthouse runtime delta is exactly **3 existing files, +23/-2 versus main**, within the
approved extension. No snapshot-specific native storage or API was added. Public snapshot lifecycle
and archive integration remain stages 2 and 3 below.

The immutable bake key is `89bb12c933c97836a5d0b943fd8f8445f168468ce677980fc8d175a9b72f8d61`; the
unchanged pinned Geth image was reused. Final results and the distinction between the original
profile run and its single-scenario follow-up are recorded under Implementation plan.

### Approved scope extension: the separate PTC duty-poll timer

Independent source reviews found another interleaving outside the agreed two-file patch. If initial
index discovery has not completed, the PTC duty poll sends no HTTP request and schedules its next
poll using a relative sleep in `validator_client/validator_services/src/duties_service.rs`. For
example, a 0.5-second delay calculated at slot S's tail can first be polled at S+1+6 seconds. Panda
then waits at that phase for the empty duty cache, while the poll sleeps until 6.5 seconds. The
`ptc_wait` mark belongs to the separate vote producer and cannot acknowledge this timer.

The existing APIs cannot preload the VC's private indices or refresh that cache. The empty poll
sends no request for Panda's relay to hold. Fixed real-time sleeps or probabilistic restarts would
not establish readiness. The existing safe behavior is a bounded error, not successful progress.
Both interleavings now fail deterministic tests of the actual native PTC duty loop: initially empty
indices and an epoch-boundary refresh. Both reach the selected race and fail to refresh the cache
while protocol time stays at phase 6 (12.79 s total). An earlier fixture lock deadlock was corrected
and is not counted as behavioral RED.

The extension changes only that PTC polling loop to use the absolute next-slot start computed from
the slot captured before polling, via the already added `instant_at` helper. The user approved this
**third runtime file** only. The implemented change adds 9 lines and removes 1, for a total of **3
runtime files, +23/-2 versus main**, excluding tests. Independent reviewers checked the normal
branch and full-slot fallback. This is the scope boundary; stop and explain before any further
client expansion. Final-bake native and real-network checks passed as recorded below.

## Decision

Keep snapshots in Panda. Stop the clients normally and save their data directories. Preserve the few
signed messages that Lighthouse keeps only in memory in a bounded Panda buffer. On restore, submit
those same messages to the existing Beacon API before starting the validator client. Lighthouse
performs its normal signature and protocol validation again.

**The implemented Lighthouse candidate changes three existing files from `main`: +23 / -2 lines.**
Those lines fix controlled-time PTC timer races. The target is zero snapshot-specific client
changes, without a new native module, database format, checkpoint endpoint or Cargo dependency.
Stage 1 verifies copied restoration, supported replay windows and startup readiness. Atomic snapshot
publication and recovery from storage failures remain stage 2 work.

## How a user-visible snapshot works

1. **During normal operation:** Panda records original signed vote submissions from both the owned
   VC relay and managed public Beacon routes before forwarding, together with their delivery
   outcome. Consensus databases remain the main source of state.
2. **Save:** at a completed slot boundary, Panda closes mutation ingress and drains its requests.
   Protocol time stays fixed. Panda stops VC, then BN, then EL, checks clean shutdown and successful
   persistence, and copies the stopped directories plus the bounded message buffer into an immutable
   snapshot. Creation then resumes the source from the same saved time.
3. **Restore:** Panda copies the snapshot into a separate working directory and starts EL and BN at
   the saved protocol time. It replays the retained signed messages through normal Beacon endpoints.
   The VC is still stopped, so it cannot sign or race with reconstruction.
4. **Resume:** Panda validates the saved chain anchors with VC absent, commits the active
   generation, then starts VC with its original keys and slashing-protection database. After startup
   checks, the network reopens behind the same URLs at the saved slot. The first user-requested
   advance waits before the PTC deadline if duties have not loaded. Failure after commit leaves the
   new generation unready; it does not roll back to a branch that may conflict with new signatures.

For example, saving after slot 32 and restoring it returns to slot 32. The next block can include
the same already-signed votes as an uninterrupted network. Saving and restoring do not create a
hidden extra block or advance protocol time. Local-file and HTTPS startup use the same artifact and
restore path. Keep the existing Panda `snapshotCreate` / `snapshotRestore` API and CLI:

```sh
panda snapshot create
panda snapshot restore <snapshot-id>
```

The ID is reusable until explicitly removed. Creation restores the source's automine setting;
restore disables automine and changes the session. External subscriptions and caches must reset.

The snapshot contains EL/BN/VC data, validator signing history, network configuration, exact bake
and image identities, saved time, state anchors and the bounded replay buffer. Existing archive
integrity and atomic publication logic can be reused. External indexers and oracles still need to
reset their own derived state when the network is restored.

## Exact client footprint

Counts describe installed Rust runtime source, excluding tests. Physical lines include comments and
blank lines. Helpers copied into Lighthouse are counted once. These are source-tree diffs, not
changes to the text of `lighthouse.patch`.

| Comparison                                   | Changed runtime files | Added / removed lines |
| -------------------------------------------- | --------------------: | --------------------: |
| Original `feat/state` versus `main`          |                    26 |            +953 / -82 |
| Current replacement versus `main`            |                 **3** |          **+23 / -2** |
| `main` versus pinned upstream                |                    31 |            +535 / -53 |
| Current replacement versus pinned upstream   |                **31** |        **+558 / -55** |
| Original `feat/state` versus pinned upstream |                    48 |          +1471 / -118 |

All three changes are in files already touched by `main`; they do not enlarge that file set. The
full upstream comparison still includes `main`'s existing clock, duty, sync and fast-warp work. This
proposal does not claim that Panda becomes an unmodified upstream Lighthouse.

| Proposed change from `main`                                              | Added / removed lines | Purpose                                                                          |
| ------------------------------------------------------------------------ | --------------------: | -------------------------------------------------------------------------------- |
| `validator_client/validator_services/src/payload_attestation_service.rs` |               +8 / -1 | Use an absolute deadline and acknowledge the selected PTC target.                |
| `common/slot_clock/src/controlled.rs`                                    |               +6 / -0 | Convert an absolute protocol timestamp using the clock's fixed origin and start. |
| `validator_client/validator_services/src/duties_service.rs`              |               +9 / -1 | Wait for the absolute next slot when refreshing PTC duties.                      |

The net growth is 21 physical lines. No snapshot-specific Rust remains in this candidate. Recipe
identities and the relevant regression tests must change when implementing it; those are not
included in runtime line counts. Panda-side implementation size has not yet been measured.

### Why the remaining timer change is needed

At the end of slot S, VC can calculate that the next PTC deadline is 9.5 seconds away. If Panda
advances the clock by 0.5 seconds before the client registers its relative sleep, that sleep ends at
9.5 seconds into the next slot. Panda waits for PTC at 9 seconds, so neither side progresses.

Disabling early PTC events does not fix this ordinary timer race. API responses and duty metrics
cannot tell Panda that an internal sleep has been registered. Fixed wall-clock delays would merely
reduce its probability. The small client change instead waits for the fixed timestamp
`start_of(target_slot) + ptc_due`, preserving ordinary upstream behavior outside controlled mode.

This vote timer and the separate duty-poll timer above are the two prerequisites for which reviewers
did not find reliable external barriers. Their deterministic regressions informed the minimal
changes; real-network checks on the final bake passed.

The regressions also cover a delayed first poll of the PTC task across a slot transition. The client
still selects `current_slot + 1`; service-spawn readiness and the separate duty-cache metrics do not
prove that this task has selected its next deadline. Independent source review supports a narrow
extension: publish a distinct `ptc_wait` mark for the selected target after calculating its absolute
deadline. While still at slot S, Panda waits for exactly S+1 on the current VC clock before
advancing either client across the boundary. Apply this every slot and after every VC replacement,
with the payload-available monitor disabled so SSE cannot cancel the marked wait. A timeout or
unexpected target keeps protocol time frozen. Absolute waits remain safe if their first poll follows
the mark. This reuses the existing clock endpoint and leaves vote selection/signing unchanged. The
extension is included in the measured three-file delta above. Its deterministic RED/GREEN covers
delayed startup, loop re-entry and advance between the mark and sleep polling. Real bootstrap,
restoration and warp checks passed on the final three-file bake.

## Panda-side details that make the design viable

### Replay actual messages, not a reconstruction of consensus

The buffer stores request bytes, relevant content/fork headers, actual message slots, order and
outcomes from network creation. Record in memory before forwarding. Serialize the buffer with the
stopped databases before declaring a clean stop or publishing a snapshot. Unclean process loss
requires explicit restore from a completed snapshot; no per-request disk journal is needed. Missing
capture evidence, unsupported encodings and unresolved partial/ambiguous deliveries prevent capture.
Bound memory without evicting needed messages; refuse admission before exceeding capacity.
Deduplication may reduce stored bytes, but must not alter normal forwarding or native responses.

Request order alone does not prove native import order inside a batch: an unknown-head item can be
reprocessed after a later item. Preflight therefore refuses different attestation contents for the
same validator and target epoch, even at the same slot. Sync messages have a head-dependent
duplicate override, so the same rule applies to different contents for one sync slot and validator.
Identical repeats remain allowed. The guard conservatively treats field-order or formatting
differences in parsed message contents as ambiguous; it does not rewrite signed fields or change the
original HTTP response.

| Existing endpoint                               | Why replay is needed                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /eth/v1/beacon/pool/payload_attestations` | Original PTC votes are not persisted by the pinned upstream pool. Preserve required messages with their original SSZ or JSON bytes and slots.                                                                             |
| `POST /eth/v2/beacon/pool/attestations`         | Verified individual attestations can still be in the non-persistent naive aggregation pool when saving. Retain the native live window and accepted future-slot messages; verify replay order against its three-map limit. |
| `POST /eth/v1/beacon/pool/sync_committees`      | Persisted contributions cover next-block use, but original current-slot messages also restore the standard contribution-query API's in-memory pool.                                                                       |

For ordinary attestations, the native lower bound is inclusive S-3. At a slot tail, clock tolerance
can also admit S+1 messages. Do not truncate the buffer at S or silently lose those votes: establish
valid replay coverage at the saved timestamp or refuse capture. Sparse slot windows also need a
regression; a three-map limit is not three consecutive slots.

This implementation takes the refusal path: any recorded message newer than the completed saved slot
prevents capture and replay before mutation. Normal forwarding remains unchanged, and capture
becomes possible after protocol time reaches that message's slot. JSON PTC/attestation/sync and SSZ
PTC rejection are covered by deterministic checks; native future-message preservation is not
claimed.

Do not use request arrival time as evidence of the message's slot. JSON exposes the slot; the pinned
fixed SSZ PTC layout needs only a slot reader, while forwarding the original bytes unchanged. Do not
replay the entire historical event stream or create replacement signatures. Regular persistent
operation pools and deposits, exits, consolidations and withdrawals already in consensus state
continue to use the saved client databases.

At a saved tail, fork choice may already have advanced to S+1. Replaying PTC(S) can therefore
produce a fork-choice timing warning while still restoring the operation pool through the existing
handler. The original fork-choice votes must survive clean shutdown; replay does not repair missing
fork choice. On this pinned implementation, pool insertion after successful PTC validation is an
infallible deduplicate-and-insert operation. Recheck that assumption on a client upgrade.

Per-slot pruning runs before main's slot/skip completion marks. After a fast skip, previous distant
PTC messages are not replayed: a block at S+1 consumes PTC for S, not for an older head slot. Sparse
attestation windows and cuts after skipping remain explicit acceptance cases.

### Bootstrap through existing interfaces

Use the existing `--disable-payload-available-monitor` option for Panda-controlled VC instances. PTC
is then produced at its regular deadline, after Panda has made duties ready. This removes the early
SSE-trigger path from this topology; it does not disable PTC, signatures or protocol checks.

Route PTC duty requests through Panda and hold their initial responses until the existing `indices`
clock mark confirms the discovery pass has finished. Transport/lookup failures block readiness; a
legitimate unregistered validator is excluded from the expected on-chain set. The pinned duties
implementation rereads the remaining validator indices after receiving the first response, so an
initially partial request can still populate the full cache. Keep validator-key mutation ingress
closed during bootstrap.

If the initial index list was empty, no request was made. Restore still returns at the saved slot;
it does not advance a slot merely to warm the cache. The first subsequent user-requested advance
triggers another poll. Panda holds that slot before the PTC deadline until existing VC metrics
`vc_beacon_ptc_count` for both current and next epochs match duties queried from BN for the full
owned validator set. These metrics read the actual cache under a lock; delivering an HTTP response
alone is insufficient. A mismatch or failed index lookup stops progress with a real-time deadline.

This readiness check is for a fresh VC cache in the controlled topology. Equal counts are not a
general proof of cache identity after arbitrary reorgs or concurrent key changes. Apply the same
startup orchestration to fresh start, restore and fast-warp VC replacement.

Keep the internal relay private. For the existing host-controller topology, use a per-session secret
URL prefix on the host-gateway relay; the pinned Lighthouse HTTP client preserves such prefixes.
Panda validates and strips it before forwarding. Metrics remain localhost-only. Runtime ports and
relay credentials are regenerated on restore and are not portable snapshot content.

### Clean stop and failures

Panda owns all supported mutation entry points and closes/drains them before stopping clients. No
external peers or independently writing validators are assumed. Private-port bypasses cannot be
covered by capture they avoid. Pending/queued EL transactions, unresolved submissions, unfinished
block/envelope/DA work and invalid or optimistic execution state prevent saving. Protocol queues
already in persisted state are permitted.

Copy data only after all three clients have exited. Require successful current-process persistence
logs as well as clean exit; upstream can report persistence failure without a nonzero exit code.
Validate copied databases through startup and saved-anchor readback before committing a candidate.
Use normal client configuration to avoid unnecessary background compaction/pruning for this
disposable network; do not treat those flags as a substitute for waiting for process exit.

An interrupted save must never publish a partial snapshot. A killed or uncertain source stays in
recovery and can restore a previously completed snapshot. A restore uses separate directories,
preserves the old generation until the candidate is accepted, and retains Panda's operation journal
and atomic active-generation switch. No transparent recovery of arbitrary mid-slot RAM is promised.

The saved-state contract covers chain state, signing history, current duty queries and subsequent
consensus operations. It does not promise identical historical transient caches, metrics or open
connections. In particular, a past-slot sync contribution may remain queryable in a live BN cache
but disappear after cold restart: its old signed messages cannot be replayed through current-slot
gossip validation. Current-slot contribution queries are included in the design and acceptance
checks. This limitation must be documented in the public snapshot contract before replacement.

## What is removed from the current client patch

Restore the branch-only native snapshot changes to their `main` versions, then apply the three-file
timer correction. In particular, remove:

- Custom checkpoint module, ABI, native park/receipt logic and parked-start protocol.
- Custom operation-pool persistence format and transfer-before-save hooks.
- Native HTTP, signing and migrator admission modules and their worker guards.
- Snapshot hooks in DA/reconstruction/pending-payload internals and background workers.
- Native PTC startup sequencing and early-trigger retry changes, replaced by the configuration and
  Panda startup sequence above.

Keep Panda's reusable archive handling, stable HTTP frontends, operation recovery, state checks and
external snapshot support where they remain applicable. Remove their dependency on native checkpoint
receipts. Reuse existing scenario assertions; do not delete acceptance coverage merely because the
implementation becomes smaller. Published artifacts using the custom database format must remain
bound to their original bake, not silently opened with the new client.

## Implementation plan

Stage 1 completed on `snapshot-minimal-r1`, Linux ARM64:

- `deno task check` passed. The ordinary suite passed **147 tests**, with 13 opt-in checks ignored.
  One additional lost-acknowledgement regression passed separately; the full suite was not repeated
  for that test-only addition.
- Three vote-timer regressions failed on main (7.10 s), and two duty-poll regressions failed on the
  two-file candidate (12.79 s). The final bake passed all **78 validator-services tests** (11.05 s),
  plus the clock, signature-reuse, weighted-selection and direct-sync targets, and built the
  immutable image successfully.
- Copied restoration at slots **0, 3, 31, 32, 127 and 128**, plus fast-skip cut **35**, passed
  through slot **226 / finalized epoch 5**. Independent review checked saved/restored SSZ bytes,
  signed next blocks and continuation, EL/CL agreement, first transactions, epoch-5 rewards and
  retained signing histories against uninterrupted references.
- Real naive-pool loss/replay RED/GREEN passed at slot 32 and sparse cut 35, including the inclusive
  S-3 pool queried before VC startup. Fresh/skip bootstrap passed with initially empty indices and a
  partial duty cache; explicit index failure left no owned client containers.
- The full profile run passed **10 scenarios**. Its honest-warp request was interrupted by an
  incorrect `PANDA_TIMEOUT_MS=60000` invocation override. Only that scenario was repeated with the
  override removed: **1 passed, 10 filtered out**, in **4 min 10 s**, including two honest 1000-slot
  jumps. The image and scenario code were unchanged. No passing scenario was rerun.

Profile evidence is in
[`reports/profiles/gloas/snapshot-minimal-r1`](../reports/profiles/gloas/snapshot-minimal-r1/). The
original `verification.json` deliberately remains failed for run
`b1e94599-eda5-4edc-9e93-ade75f5339ff`; `warp.json` records the successful isolated follow-up
`honest-followup-20261005`. This is scenario-by-scenario stage-1 evidence, not a claim of a single
successful full-profile release verification. Private detailed evidence remains under ignored
`.cache/snapshot-design-main/`, `.cache/snapshot-cold-restart/`, `.cache/snapshot-naive-replay/`,
`.cache/ptc-bootstrap/` and `.cache/snapshot-ptc-timer/`. All Panda-owned test containers were
removed.

1. [x] Prove direct cold save/restart/restore on the main-derived client using the buffer and
       ordinary Beacon APIs. Add failing behavioral regressions first; preserve independent state
       and next-block comparisons before adapting the rest of the feature. Reuse the existing Geth
       image.
2. [ ] Adapt existing storage, clean stop/resume and snapshot create/list/restore/remove to this
       backend. Preserve reusable IDs, stable URLs, atomic publication and recorded request
       outcomes. Validate and prepare restoration before stopping a healthy source. A published
       snapshot must survive source restart failure and be returned in the error; partial copies
       stay unpublished.
3. [ ] Adapt existing local-file/HTTPS export and startup to the same format. Retain safe
       extraction, integrity and exact bake/platform checks. A retained active volume takes
       precedence over its initial seed. Update HTTP/OpenAPI/CLI docs and complete the
       release-platform verification.

### Acceptance checks

The first three checks establish stage 1. Existing profile scenarios below also passed; new storage
failure and public archive/lifecycle checks belong to stages 2 and 3 and remain unverified.

- Demonstrate the two original losses on the main-derived client: PTC after restart and naive
  attestations at the epoch boundary; repair them using only Panda replay.
- Compare uninterrupted and restored networks at slots 0, 3, 31, 32, 127 and 128, including complete
  signed next blocks, state roots, PTC/sync bits, rewards, signing history and resumed finality.
- Cover sparse/fast-skip cuts, current-slot contribution queries, delayed/partial index discovery,
  the empty-initial-index case and the exact PTC timer interleaving above.
- Preserve deposit/activation, consolidation, exit/withdrawal, blob/DA, operation-pool and external
  consumer scenarios. Any currently supported case that fails remains a blocker, not a silently
  removed guarantee.
- Exercise buffer overflow and interrupted buffer persistence, partial/ambiguous requests, stop
  failure, crashes during copy, replay rejection, candidate-start failure and active-generation
  publication failure.
- Verify archive import through local paths and HTTPS, repeated restore, stable URLs, and the
  packaged service on the architectures being released.

Historical persistence evidence remains in `feat/state` at `docs/snapshots-p3-persistence.md`. Keep
that evidence and the working implementation until the replacement passes these checks. A new native
change requires a concrete failed Panda-side alternative and independent minimality review.
