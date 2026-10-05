# Snapshots: implementation plan

Split from revision 4 of the combined plan, reviewed against `main` at `0acee41` on October 2, 2026.
This plan owns reusable snapshot creation, restore, recovery and consumer reset. The separate
[hardfork transition plan](hardforks-plan.md) owns schedules and fork crossing.

**Status: snapshot functionality complete and accepted locally on Gloas/Linux ARM64, October 4,
2026.** P0–P5, snapshot P9 and P10 are closed. The complete current profile passed **19/19**
scenarios in **1,975.949 s** with unchanged executable sources and exact bake binding. Unit,
Docker/baker, packaged-service, measurement and requirement-audit gates also passed; see the
[final acceptance report](snapshots-verification.md).

P5 restore paths were implemented early to verify reuse of P4's artifact; that overlap did not count
as P4 acceptance. Each stage below records its own executed criteria. The finished feature includes
durable reusable archives, explicit recovery, cleanup, persistent container replacement, protocol
queues and external-consumer reset/replay. [Lifecycle](lifecycle.md) documents usage. AMD64
publication and dynamic hardfork transitions are outside this local acceptance.

Original stage IDs are retained so existing reports remain meaningful. P6–P8 belong to the hardfork
plan. P9 and P10 are divided by scope between the two documents; joint snapshot/transition checks
are owned by P9 in the hardfork plan and require both features.

| Stage                                       | Status                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P0 — pinned inputs and state inventory      | Complete; clean Geth built and checked.                                                                                           |
| P1 — persistence/admission regressions      | Complete; behavioral RED and independent reference evidence retained.                                                             |
| P2 — lifecycle, storage and admission       | Complete; SDK/CLI/container and managed ingress verified.                                                                         |
| P3 — native checkpoint and cold resume      | Complete; native r5, cuts 3/31/32/127/128, blob/KZG and refusal/continuation checks; full profile 13/13.                          |
| P4 — snapshot creation                      | Complete: independent state, seven persistence failures and eight real creation process-loss cuts passed.                         |
| P5 — restore, recovery and public commands  | Complete: cleanup, 11 recovery cuts, persistent container replacement and acceptance audit passed.                                |
| P9 — snapshot protocol and consumer fixture | Complete: deposit/activation, consolidation/exit/payout and separate consumer replay scenarios passed; registered and documented. |
| P10 — snapshot release verification         | Complete: full profile 19/19, unit/check, Docker/baker, current package, disk measurements and final acceptance audit passed.     |

## Completion and release handoff

The original snapshot acceptance and the subsequent PTC reliability repair are complete locally. The
[external snapshot follow-up](external-snapshots-plan.md#review-findings-and-follow-up) records the
two narrow client fixes, native red/green evidence and the full 20-scenario verification on
`ptc-reliability-r7` (Lighthouse baker 4, checkpoint ABI 1). The result below is historical evidence
for the original snapshot implementation.

All 19 original scenarios completed in one run on `p3-checkpoint-r5` without rebuilding its clients.
Final readback matched the suite hash, bake and every report; no containers, networks or volumes
remained for the run's 25 recorded owners.

Publishing is a separate action: the existing published client lock is older than checkpoint ABI 1.
Use the normal Lighthouse baker 4 release PR, then the AMD64 Panda verification/publication flow.
The local ARM bake and package are verification artifacts, not replacements for a published lock.

Update the stage table, execution checklist, evidence and next step after each completed work block.
Keep implementation progress distinct from acceptance. Starting dependent verification does not
complete a prerequisite; any overlap must be stated here with its reason. Existing passing results
remain evidence and are repeated when relevant changes or an outstanding gate require it.

Snapshot development evidence (October 4, 2026):

This is a chronological record. Later entries and the acceptance tables supersede earlier statements
about open work; historical standalone results are not retroactively full-profile passes.

- A real `gloas/p3-checkpoint-r5` creation probe passed at slot 3: unchanged saved time and
  execution/consensus heads, new controller session, original automine setting restored, idempotent
  request replay, next signed transaction at slot 4 and resumed finality at slot 128. Capture took
  12.90 seconds; the full probe took 33.88 seconds. It reused the pinned client images. This
  single-cut probe predates the subsequent candidate-startup changes and is not the final snapshot
  release gate.
- An earlier unit/adapter suite passed 296 tests and 106 nested checks, with 19 opt-in scenarios
  skipped. Storage checks cover immutable independent copies, corruption/refusal and partial-copy
  failure. Candidate checks cover parked startup, preserving old authority before commit, failed
  startup/cleanup and lost acknowledgement of pointer publication. Adapter tests do not establish
  real protocol continuation.
- Additional SDK coverage reproduced an incorrect success when a reused operation ID belonged to
  another payload. Reconciliation now checks the payload as well as the operation ID.
- A real live-restore probe on the same Gloas bake passed three restores of one slot-3 snapshot,
  including restore after SIGKILL of its Beacon Node. Saved time, signed block, EL hash, balances
  and nonce matched independently captured values; discarded receipts disappeared. One SDK and its
  public URL survived replacement. Replaying a request ID did not restore twice. A subsequent signed
  transaction, real PTC and finality through epoch 2 at slot 128 passed. Restores took
  12.18/11.71/11.97 seconds; the full probe took 70.27 seconds. Existing images were reused.
- Controller/SDK checks cover copy-before-discard availability, cancellation of hung requests, exact
  payload deduplication, shutdown races, pre/post-commit failures and lost response recovery. A
  separate regression requires discard intent to be persisted before Timeline cancellation.
- A real offline probe reused a retained snapshot: owning SDK startup, CLI snapshot startup, SIGKILL
  of that controller, recovery service on the same public port, explicit restore, next
  transaction/finality, graceful SIGTERM and verified cold resume all passed in 55.68 seconds.
  Recovery status exposed the actual active generation without starting unsafe clients or claiming a
  current protocol time. The snapshot survived owning close and both process restarts.
- Archive integrity now covers modes, numeric ownership and empty directories as well as file bytes.
  Four behavioral regressions reproduced acceptance of changed permissions/directories and passed
  after the fix. Removal has durable deletion records and interruption checks at intent, rename,
  partial unlink and lost acknowledgement. It preserves active data and other archives.
- A real SIGKILL immediately before candidate commit reproduced orphaned candidate containers
  blocking the next restore. Explicit restore and `down` now clean every runtime of the exact owner
  under the network lock. A separate real repeat passed, and adapter regressions verify that another
  owner remains untouched.
- The registered [snapshot scenario](../bakes/gloas/tests/snapshots.ts) passed in 78.56 seconds on
  `gloas/p3-checkpoint-r5`: three restores, including a killed Beacon Node, independent chain and
  signing-history checks, offline startup, archive removal, next transaction/PTC and finality at
  slot 128. Capture took 11.59 seconds, the archive was 11,703,868 bytes, restore took 11.71–12.36
  seconds and the first transaction took 118 ms. The report is a standalone scenario result, not a
  full-profile verification.
- The registered [recovery scenario](../bakes/gloas/tests/snapshot_recovery.ts) covers eight durable
  restore journal boundaries with real controller SIGKILL; all eight passed in 219.13 seconds. Each
  cut checked active-generation authority, explicit recovery, restored time/roots and the next
  block. Its child-process fixture is included in the suite fingerprint. Capture/copy/cleanup
  interruption, packaged-container loss, protocol queues and the consumer reset/replay fixture
  remain release work; P9/P10 stay open.
- P4.4's expanded snapshot scenario passed in 84.96 seconds on the same pinned images. A real
  mutable contract held `0x123456789abcdef` before capture; discarded branches changed its storage.
  Source resume, three restores and offline startup preserved that original storage, the complete
  pre-snapshot receipt and all 3,144,225 bytes of independently captured Beacon SSZ. The next
  transaction and finality at slot 128 also passed. The current standalone snapshot report contains
  this result, superseding the earlier 78.56-second scenario. The first new fixture run reverted
  before capture because its storage allocation gas limit was too small for pinned Amsterdam;
  correcting that test limit enabled the complete run. No snapshot runtime change was needed.
- P4.5's seven injected persistence failures passed: manifest write, file sync, rename and directory
  sync; publication rename, lost rename acknowledgement and parent-directory sync. Every case
  preserved source readiness, generation and time. Pre-publication failures advertised no archive;
  post-rename failures returned the usable archive in a failed operation and did not repeat the
  mutation on retry. Real process-loss evidence is recorded separately below.
- P4.5 recovery regression: a recovery-only service previously accessed the absent live session
  before reconciling an interrupted create. Both unpublished and published cases failed the new
  regression. Reconciliation now reads the archive and journal without starting clients, returns the
  surviving archive when present and records a failed interrupted operation. Both regressions passed
  after the fix. `deno task check` passed; the full unit/adapter suite passed 298 tests and 115
  nested checks, with 20 opt-in scenarios skipped.
- P4.5's registered [creation process scenario](../bakes/gloas/tests/snapshot_creation.ts) passed
  all eight SIGKILL cuts in 298.68 seconds: before checkpointing, after clean stop, inside copying,
  after manifest write, before publication, after publication, before source resume and after the
  successful outcome was persisted. Unpublished artifacts stayed hidden; all three published cases
  passed full readback and actual restore. Recovery preserved active authority and clean source
  bytes, reported uncertain sources as unready, reconciled the exact request without repeating
  capture and continued with the next block after explicit restore. The
  [standalone result](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-creation.json) closes
  P4.5. The scenario removed its exact-owner runtime and successful fixture data. Existing images
  were reused; no native build was needed. P4 is accepted; P5/P9/P10 remain open.
- P5 cleanup now uses durable operation references: allocation is recorded before mkdir, active
  generations and generations with any client container are protected, and unpublished archives and
  discarded generations can be removed after interruption. Unrecorded directories, other owners and
  published snapshots are preserved. Cleanup has its own outcome and does not undo a successful
  restore. Regressions first reproduced partial-copy and discarded-branch leaks.
- Two cleanup audit findings were reproduced and fixed: `down` previously reached client deletion
  before acquiring the snapshot operation lock, and cleanup could retire an old branch after a new
  pointer became visible while directory sync continued failing. `down` now acquires journal
  ownership first; cleanup syncs the active pointer and root before deleting inactive data. Failed
  durability confirmation retains the old files and reports failed cleanup. Interrupted unlink after
  removal of `owner.json`, lost rename acknowledgement, directory sync, pending archive deletion,
  foreign owners and symlinks have executed regression coverage.
- The expanded real recovery scenario passed **11/11** cuts in **317.83 seconds**, including loss
  inside copying, after cleanup rename and during partial unlink. After each explicit recovery, only
  the active generation remained and the next block passed. This run preceded the additional
  authority-sync guard; that guard passed its failing regression and the subsequent full unit and
  real state checks. The final `deno task check` passed; `deno task test` passed **309 tests and 122
  nested checks**, with 20 opt-in scenarios skipped. Docker smoke passed in 3.44 seconds.
- The real snapshot scenario then passed on the final cleanup code in **82.94 seconds**: complete
  independently saved state, repeated/faulted/offline restore, no discarded-generation residue,
  archive removal, next transaction and finality through epoch 2. Capture took 12.44 seconds,
  restores 12.59–12.73 seconds, the archive was 11,707,825 bytes, and the next transaction took 123
  ms. These current standalone results are not full-profile verification. Packaged-container loss,
  P9 and the final P10 gate remain open.
- P5's packaged-container gate subsequently passed in **117.88 seconds** on the fixed local Panda
  image. It preserved `/data/panda` through SIGKILL and outer-container replacement, required
  explicit recovery, restored slot 195 and discarded the slot-196 future. Restore took **9.49
  seconds**, the next signed transaction **111 ms**, and finality reached epoch **8** at slot 324.
  The first run had exposed stale Geth IPC socket cleanup; focused RED/GREEN and the separate
  fixed-image run verified the correction. The P5 acceptance matrix is now closed. The full
  unit/adapter suite passed **311 tests and 122 nested checks**, and static checks passed. P9 and
  the full P10 gate remain open.

Gloas is the only active profile. `src/active_profiles.ts` temporarily excludes Pectra from default
CI, releases and verification. Historical P0–P1 results for both profiles remain available. All
prerequisites below are implementation work, including client research and fixes.

## Intended behavior and scope

A test prepares the network and protocol once, saves a snapshot, executes a scenario, restores the
same point and executes another scenario. EL/CL/VC data and protocol time return to the saved
values. Snapshots are reusable and survive process exit when stored persistently.

Initial scope: controlled Panda networks, mainnet timing, disposable validators owned by the test,
completed slot tails and the same compatible images/platform. Hot or VM snapshots, baseline mode,
remote signers, cross-host archive transfer and arbitrary database migrations are excluded.

Snapshot creation and restore on the existing single-fork Gloas network do not require dynamic
hardfork support. A snapshot preserves the network's immutable schedule and cannot change it. Saving
around a future fork and replaying the transition is a joint acceptance scenario in the
[hardfork plan](hardforks-plan.md#p9-verify-snapshots-across-transitions).

## The PTC persistence prerequisite

The Payload Timeliness Committee sends signed Gloas messages about execution payload availability
and blob data availability. The next block uses those messages.

At Lighthouse pin `2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`, `payload_attestation_messages` was
absent from `PersistedOperationPool`. Loading the database created an empty pool, while
`get_payload_attestations` needed messages from the preceding slot.

Executed native and real-client regressions reproduced this in P1. After either a BN/VC restart or
an EL/BN/VC restart at slot 3's tail, block 4 lost all 512 PTC positions and had a different state
root. The block still existed and EL/CL agreed. The defect was loss of exact continuation; it did
not imply that every restart stopped the chain. See [P0–P1 evidence](snapshots-p0-p1.md).

P1/P3 use real signed messages to reproduce the loss, persist the missing state, and compare the
next real block against an independently running network.

## Findings and assigned prerequisites

These are the initial findings and risks; completed fixes are recorded in the verification report.
Source inspection alone is not verification. Original finding IDs are retained.

- R1: PTC messages were omitted from operation-pool serialization. Addressed in P1/P3.
- R2: Naive attestation/sync aggregation pools start empty. Some verified votes enter the persistent
  operation pool only when the next block is produced. P0/P1 identify the data needed at the chosen
  cut; P3 preserves it or transfers it through the normal verified path without producing a block.
- R2a: Pending envelopes, the DA checker and pending payload caches are reset on startup. P0
  classifies each item: recreate a safe cache, finish delivery/verification, or refuse
  checkpointing. Restore must reject missing persisted operation-pool data rather than silently
  create an empty pool.
- R3: Queued fork-choice attestations were not persisted. P3 proves that they are drained or saves
  them, and records the actual fork-choice slot, which can be ahead of protocol time.
- R4: The original lifecycle always generated genesis and deleted runtime volumes; clocks,
  completion marks and Engine readiness lived in memory. P2/P3 add open-existing, stop-preserve,
  parked startup and a new controller session.
- R5: The Timeline lock does not cover EL/CL/VC RPC, direct relays or SSE. An empty txpool alone
  does not prove that all accepted submissions are resolved. P2 adds managed ingress and a durable
  submission ledger while retaining Geth's transaction semantics. Research-source behavior must be
  reproduced on the selected binary before being called a binary defect.
- R6: Fresh VC startup permits a new slashing database; restore must not. Restoring both chain state
  and signing history creates another isolated test branch, not global protection against signing
  conflicts across copied branches. Addressed in P0/P3/P5.
- R7: Upstream shutdown can merely log persistence errors. P3 requires a successful checkpoint ACK,
  durable readback and real continuation; exit code zero alone is insufficient.
- R8: Capture/restore can fail during copying, startup or commit. P4/P5 use temporary artifacts,
  integrity checks, separate generations, a durable operation journal and explicit recovery stages.
- R10: The earlier research Geth checkout was not proof of the actual image's source. The old binary
  reported revision `5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186` with `vcs.modified=true`. P0 requires
  its complete build diff or a new immutable build from known inputs.
- R11: External providers, oracles and indexers retain reverted events and caches. P9 supplies and
  executes a reset/replay fixture.

## Design decisions

### Capture and restore

- Create requires a healthy controlled network at a completed slot tail. Saving never advances time.
- Pending/queued EL transactions and unresolved accepted or ambiguous submissions block create with
  a specific reason.
- Supported native CL operations, including voluntary exits, BLS changes and slashings, retain their
  pool/state status and pass round-trip and continuation tests. Unknown types or unproven
  persistence cause refusal. A GET pool response may retain already-included operations until
  pruning/finality; classify them using native inventory and current state, not merely a nonempty
  HTTP list.
- Deposits, consolidations, exits and withdrawals already queued in consensus state are preserved;
  those queues need not be empty.
- Ordinary attestation/sync/PTC pools are part of continuation. Requiring every CL pool to be empty
  would discard valid protocol state.
- Restore is available after a faulted advance or client crash without `Timeline.assertHealthy`.
  Work from the abandoned branch is cancelled; the candidate checkpoint is validated independently.
- Restore returns exactly the saved time with automine off. A successful create-and-resume restores
  the original automine setting.

### Storage and lifecycle

- One persistent Panda root holds the journal, active-generation pointer, snapshots and each
  generation's EL/BN/shared/VC data. Container deployments use `/data/panda`; local data stays
  ignored.
- Snapshot-capable sessions bind-mount owned generation directories. Existing runtime volumes are
  not migrated implicitly; capability starts with a new managed network or verified checkpoint.
- Internal dockerd/image caches may be recreated from exact pinned image archives. A snapshot does
  not archive the whole daemon.
- Scoped `Infrastructure` copy helpers preserve permissions and validate owned paths. Every Docker
  mutation is scoped to the exact `io.panda.id`; normal client operations also select the
  generation. Explicit restore and `down` hold the network lock while removing all runtimes of that
  owner, including an orphaned pre-commit candidate. Global prune is prohibited.
- Owning SDK `close()` and CLI `down` destroy the active runtime while retaining snapshots. Borrowed
  `close()`/disconnect only closes that connection. `reset` creates a fresh generation.
- Persistent-service SIGTERM performs stop-preserve and a verified checkpoint. A destructive
  `Controller.close()` in `finally` must not erase durable state. Restart follows the active
  pointer. Exhausting the documented shutdown budget or killing the process marks the state unclean.
- Snapshots survive `down`/`reset` and are removed only explicitly.
- A clean stop provides a verified resume checkpoint. After SIGKILL, database files alone are
  insufficient: ingress remains closed and unproven state requires an explicitly chosen saved
  snapshot. There is no hidden rollback.

### Ingress, operations and SDK

- The persistent HTTP service owns a replaceable `NetworkSession`: manifest, Timeline, Automine,
  EngineGate and clients.
- Public EL/CL/VC URLs remain stable. Local and container modes use the same managed frontends,
  track active requests and close SSE during session replacement.
- Private upstream/clock ports remain localhost-only for the host controller. The public manifest
  and SDK omit them; fixtures use managed endpoints for user operations.
- Only a new managed-ingress generation or verified checkpoint receives snapshot capability.
  Previously accepted requests in an unmanaged live network cannot be reconstructed retroactively.
- Concurrent administrator writes to private ports during checkpointing are unsupported; this is not
  a security boundary against the machine's owner.
- Lifecycle/operation status stays available during maintenance or faults without client RPC or a
  healthy Timeline. It exposes phase/result/error and remains unready until publish, allowing the
  SDK to recover the result of a lost HTTP response.
- Maintenance closes admission, drains accepted finite requests and stops automine outside the
  Timeline lock. A failed drain refuses save instead of copying uncertain state.
- The EL ledger durably records intent before forwarding and hash/result before successful ACK. It
  handles batches, notifications and unknown transport outcomes. Entries resolve on a canonical
  receipt, a proven consumed nonce, or a proven pre-admission rejection. Terminal rejection uses a
  tested classification for the exact pinned Geth, including invalid signatures/transactions; an
  arbitrary RPC error is not proof of rejection. Accepted/ambiguous entries survive an empty txpool.
  Panda never automatically resends a transaction.
- Public operations will be create/list/restore/remove and start-from-snapshot. Archive
  import/export and cross-host transport are deferred.
- `SnapshotRef` identifies a reusable artifact; an operation ID identifies one request. Repeating
  ID+payload returns its prior result, reusing an ID with another payload fails, and a new ID can
  restore the same snapshot again.
- Restore changes the generation. SDK waits fail explicitly, filters/SSE are reset, and external
  libraries require their own cache reset.

### Signatures and external consumers

- Restore rewinds an isolated disposable test branch with controlled devnet keys. Real BLS checks
  and slashing protection remain enabled within each branch.
- Signed branches sharing keys/genesis must not be mixed. Managed storage enforces one active local
  lineage; it cannot globally lock copies on other machines.
- Validate local keystores, definitions and the complete password/slashing set inside owned mounts.
  Reject remote signer definitions and external key paths.
- Panda cannot prove exclusive ownership of arbitrary imported keys. Snapshot mode uses declared
  disposable test keys; remote signers/external VCs are excluded and their configurations checked.
- Oracle/indexer databases are outside the snapshot. P9 delivers a tested consumer reset/replay
  fixture rather than leaving that integration order undefined.

## Stages and acceptance criteria

### P0. Record exact inputs and inventory all state

Dependencies: none. Scope: bake/native and controller.

- Match actual image IDs/platforms to manifests and extract build metadata. Obtain the complete diff
  of modified Geth or build a new immutable EL from an agreed full commit and explicit patches.
  Existing tags remain unchanged.
- Inspect genesis scripts/templates separately from the CL genesis binary. The inspected shell
  source is `51fb77af…`; the binary revision is `9bbbf55fa9603b4c2e656fe7c441a340ea61f6d6`.
- Inventory both profiles: EL databases/ancients/blobs/accepted work; BN hot/cold data, fork choice,
  operation/naive/sync/PTC/custody pools; VC keys/definitions/secrets/slashing; controller clocks,
  sessions and admission state.
- Assign every item to preserve, demonstrably drain, recreate without signatures, or refuse before
  save. Distinguish pending from included-but-retained CL operations. Pending envelopes/DA must
  finish or cause refusal; missing persisted operation-pool data is an error.
- Define snapshot schema, checkpoint/clock ABI and capabilities. Old bakes cannot claim capabilities
  they lack.

Acceptance: no important state has an undefined treatment; exact build inputs or a concrete new
build are available; checks have observable expected results. Dynamic transitions are not a P0 gate.

### P1. Add minimal reproducible regressions

Dependencies: P0. Scope: native/tests.

- Use the Lighthouse harness with real BLS messages, normal gossip verification, production
  serialization and next-slot payload attestations. Check data, signatures and all PTC bits,
  including repeated validator indices; do not use `Signature::empty()`.
- Identify losses in naive pools and the fork-choice queue at the selected cut. Recreated harmless
  caches do not require persistence merely because their initializer is empty.
- Compare an independently running network with direct cold restarts of the same client data/time:
  BN/VC first, then EL/BN/VC. Do not use a future snapshot API to establish its own correctness.
  Missing APIs/imports or compilation failures are not behavioral RED.
- Reproduce deferred/ambiguous EL outcomes and lost ACK on the selected binary. Proven rejection
  must not block create; unknown acceptance must. Unreproduced research-source risks remain risks.

Acceptance: preserve commands, pin/key and observable failures. Checks without an actual defect are
coverage, not fabricated RED evidence.

### P2. Implement lifecycle, durable storage and managed ingress

Dependencies: P0 and relevant P1 regressions. Scope: controller/Docker.

- Separate initialize-new/open-existing and stop-preserve/destroy. Implement a persistent service
  with replaceable sessions and the SDK/CLI/SIGTERM contracts in the storage and lifecycle section.
  Test each entrypoint, including owning close deleting only its runtime and borrowed close
  retaining the shared service.
- Add generation bind mounts, ownership/path checks and copy helpers. Resume cannot generate fresh
  genesis.
- Put maintenance/operation locking outside Timeline; drain automine and requests, cancel faulted
  branches for restore, and manage all EL/CL/VC frontends. Status remains available when clients do
  not run; readiness reflects lifecycle instead of blocking on their RPC.
- Add the durable EL ledger with confirmed/consumed/rejected terminal states and unresolved states.
  Route supported user ingress and fixtures through managed frontends.

Acceptance: save/advance/automine/import/shutdown races do not deadlock or lose acknowledged work;
failed drain refuses capture; unrelated networks remain untouched. Native continuation is a P3 gate.

### P3. Implement a lossless native checkpoint and verified cold resume

Dependencies: P0/P1/P2. Scope: Lighthouse native and controller. Earlier persistence work is
recorded in [PTC and attestation persistence](snapshots-p3-persistence.md).

- Add an explicit durable Panda checkpoint ACK. Drain native writers/queues at a consistent cut and
  record actual roots, fork-choice slot, time and required protocol pools; do not infer success from
  process exit alone.
- Persist versioned PTC and other required buffers in BN storage. Supported user operations must
  survive load and be included once; retained included operations are classified by state. Pending
  envelopes/DA or unknown work cannot be silently discarded. Retain normal verification; fabricated
  completion marks, empty substitutes and disabled BLS are prohibited.
- Start at the saved time with duties parked. Agree EL/BN anchors, open the existing VC slashing DB
  without `--init-slashing-protection`, and reject missing/corrupt data. Recreate transient Engine
  payload IDs, handles and marks; they are not evidence of completed work.
- Stop VC → BN → EL cleanly while retaining data. Use a real bounded watchdog; forced termination
  cannot produce a successful checkpoint.
- Build new native bakes only when native inputs change, with native tests inside the build.
- Test real Gloas stop/resume with exact time/roots/checkpoints/signing history, then the next
  block, participation, economics, transaction and finality. Pectra is deferred.

Acceptance: restart preserves continuation against a fresh independent network with identical inputs
and no snapshot implementation. Normal pinned code verifies signatures/transitions. Compare future
hashes only for identical block inputs; define comparisons before running, not after a mismatch.

### P4. Implement durable snapshot creation

Dependencies: P2/P3. Scope: controller/storage.

**Status: complete and accepted locally on Gloas/Linux ARM64, October 4, 2026.** All five P4
criteria below have executed evidence. Filesystem cleanup of failed/inactive copies is covered by
P5; the complete snapshot release gate remains P10.

- [x] **P4.1 — Create and resume at the saved cut.** Managed checkpoint, stopped-source copy and
      source resume are implemented. Real Gloas creation checks preserve time and heads, restore
      automine, and continue with a signed transaction and finality. The registered snapshot
      scenario also verifies that the artifact survives owning close and can be reused.
- [x] **P4.2 — Archive identity and integrity.** Exact config/bake/images/platform/checkpoint are
      bound to checksums. Storage regressions cover independent copies, changed bytes, missing
      files, permissions, numeric ownership inventory, empty directories, unsafe paths, symlinks and
      transient generation entries. Captured artifacts pass full readback before publication.
- [x] **P4.3 — Request outcomes.** Controller/SDK regressions cover same-request replay, a lost
      successful HTTP response, failed copying with source recovery, and a published artifact
      retained in a structured error when source resume fails. Process-loss behavior is covered
      separately by P4.5.
- [x] **P4.4 — Complete independent-state evidence.** The expanded real scenario independently
      captures nontrivial contract storage, an included receipt and full Beacon SSZ before creation
      and compares them after source resume, three restores and offline startup. Time, signed block,
      EL hash, balances, nonce and signing history checks also pass. Queued protocol operations
      remain assigned to P9.
- [x] **P4.5 — Complete creation failure evidence.** Injected copy failure and corruption before
      publication pass. Seven manifest/publication persistence failures also pass, including rename
      success followed by a lost acknowledgement. All eight real creation process-loss cuts passed;
      see evidence above. Incomplete artifacts stay unpublished, published artifacts remain usable,
      and source readiness and operation results reflect durable state. The separate eight
      **restore** journal cuts belong to P5.

Evidence: [storage regressions](../tests/snapshots_test.ts),
[controller regressions](../tests/snapshot_controller_test.ts),
[real state scenario](../bakes/gloas/tests/snapshots.ts),
[state result](../reports/profiles/gloas/p3-checkpoint-r5/snapshots.json),
[creation process scenario](../bakes/gloas/tests/snapshot_creation.ts) and
[creation result](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-creation.json).

Original scope and acceptance criteria:

- Gate/drain and check health, completed cut, unresolved EL admission and CL checkpoint
  completeness. Capture anchors after drain. Tests independently read expected
  roots/storage/receipts/balances/SSZ before capture, instead of trusting the implementation's new
  manifest.
- Obtain a native checkpoint, stop cleanly and copy only stopped databases into a temporary
  snapshot. The manifest binds schema/ABI, exact images/platform, bake key,
  genesis/schedule/versions/constants, time, EL/CL roots/checkpoints and file inventory/checksums.
- Exclude old PIDs, locks, ports, host paths and transient handles. Keep permissions private and
  snapshots outside Git and ordinary CI log uploads.
- Publish atomically, then resume the original network. If publication succeeds but resume fails,
  return a structured partial failure with snapshot ID and stopped state; retain the usable
  snapshot.

Acceptance: an immutable reusable artifact, no hidden blocks/time changes, and no damaged
publication on disk-full/copy/persistence failure.

### P5. Implement restore, recovery and public commands

Dependencies: P4. Scope: controller/API/CLI/container.

**Status: complete and accepted locally on Gloas/Linux ARM64, October 4, 2026.** Early P5 work
supplied the restore path needed to verify reusable P4 artifacts. All P5 items below now have
executed evidence. P9 and the full local P10 release gate are also accepted below.

Fixed finding: the first packaged-container loss run restored the saved state, endpoints and
receipts, but failed cleanup because a crashed Geth leaves an `el/geth.ipc` Unix socket. Archive
inventory correctly rejects sockets; deletion of a journaled inactive generation now handles this
crash residue after the exact-owner container check. The focused regression failed before the fix
and passed after it. The separate fixed-image packaged run passed in **117.88 seconds**: restore
took **9.49 seconds**, the next transaction **111 ms**, and real finality reached epoch **8** at
slot **324**, with EL/CL agreement. It retained the named volume while deleting and replacing the
entire outer service container and its private Docker storage. No native client was rebuilt.
Exact-owner test containers and the volume were removed after completion; see the
[sanitized result](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-container.json).

- [x] Live repeated restore, saved time/heads/signing history, stable public URLs, automine off,
      faulted Beacon Node recovery, SDK/CLI entrypoints, offline startup and explicit archive
      removal.
- [x] Real controller SIGKILL at eight restore journal boundaries, with active-pointer authority,
      explicit recovery and next-block checks. Adapter checks cover lost responses, pre/post-commit
      failures, removal interruptions, ownership and shutdown races.
- [x] Durable cleanup of incomplete capture copies, inactive restore candidates and discarded
      generations. Allocation is recorded before mkdir; journal-scoped deletion protects active
      authority, attached clients and unrecorded data. Partial deletion is retryable. Persistence,
      ownership and failure reporting checks and the real state/restore scenario passed.
- [x] Interruptions inside restore copying and generation cleanup. The real recovery scenario now
      covers 11 cuts, including post-rename and partial-unlink loss. Unit checks additionally cover
      pending-archive unlink and persistent active-pointer sync failure.
- [x] Packaged-service/container loss with retained `/data/panda`: create → mutate → force-stop and
      replace the service container → recovery-required → explicit restore → next transaction and
      finality. Keep the existing graceful startup/stop/resume checks.
- [x] Reconcile the complete P5 acceptance matrix. P9 and P10 are accepted separately below.

Evidence: [restore scenario](../bakes/gloas/tests/snapshots.ts),
[recovery scenario](../bakes/gloas/tests/snapshot_recovery.ts) and
[11-cut result](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-recovery.json),
[cleanup regressions](../tests/snapshot_cleanup_test.ts) and
[current state/restore result](../reports/profiles/gloas/p3-checkpoint-r5/snapshots.json).

P5 acceptance audit (October 4, 2026):

| Contract                                                                              | Executed evidence                                                                                                                         | Status |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Validate before stopping: identity/configuration, complete bytes/metadata, free space | `snapshots_test.ts` and `snapshot_controller_test.ts`; capacity injection refuses allocation and preserves the running source and archive | Passed |
| Prepare independently; start parked; publish only verified authority                  | `snapshot_network_test.ts`, controller regressions and real state/recovery scenarios                                                      | Passed |
| Repeated, faulted and offline restore; same SDK and stable URLs; automine off         | Real snapshot scenario, retained-artifact CLI/SDK probe and adapter checks                                                                | Passed |
| Durable stages, lost replies, exact request deduplication, no automatic rollback      | Journal/controller/API regressions; 11 real restore process-loss cuts                                                                     | Passed |
| Remove only unused archives; preserve foreign owners; retry partial cleanup           | Archive/removal/cleanup regressions, real copy/cleanup cuts; stale Unix socket RED followed by focused GREEN                              | Passed |
| CLI create/list/restore/remove/open and operation lookup                              | CLI routing/offline-removal regressions plus real offline CLI startup/recovery probe                                                      | Passed |
| Persistent packaged service after loss and replacement                                | Stale-socket cleanup reproduced and fixed; separate real packaged run passed, including next transaction and finality                     | Passed |

The focused capacity check exercises the free-space guard after archive validation without filling
the host disk. It is storage-boundary coverage, not additional real-client evidence. After the Unix
socket fix, `deno task check` passed and the full unit/adapter suite passed **311 tests and 122
nested checks**, with 20 opt-in scenarios ignored. All P5 acceptance rows are now satisfied on the
selected local platform; P9 and the final P10 gate are accepted below.

- Validate manifest, checksums, compatibility and disk space before stopping a working network.
  Reject chain/schedule overrides.
- Support faulted networks. Prepare a separate generation, never unpack over active data, and stop
  old signers.
- Start candidates parked and verify real anchors/pools/keys/clocks before publishing. Readiness
  must not mine a block or send a test transaction.
- Journal commit/publish/cleanup durably. The old generation is authoritative before commit and the
  new one afterward. Recover a healthy source only after validation; a faulted source cannot be
  advertised as ready. Never automatically return to the old branch after publishing new signatures.
- Recover the journal stage after SIGKILL. Database presence does not imply a consistent active cut;
  report recovery-required and wait for explicit restore when consistency is unproven.
- Same operation ID+payload returns the recorded result without repeating restore. A new ID may
  restore the same snapshot again. Prevent removal of an in-use snapshot.
- SDK/CLI create/list/restore/remove/start-from-snapshot use one mechanism. Verify `/data/panda`,
  stable endpoints and an SDK object that survives session replacement.

Acceptance: create → mutate → restore → mutate → restore; faulted network → restore → next
transaction/finality; process/container loss; lost HTTP responses before/after commit; corrupt or
missing files; unrelated resource preservation. Cover every recovery stage.

### P9. Snapshot protocol and consumer fixture

Dependencies: P5. Scope: integration/SDK documentation. This is the snapshot portion of the original
P9; dynamic fork crossing is not a prerequisite for this fixture.

**Status: complete and accepted locally on Gloas/Linux ARM64, October 4, 2026.** All four items
below have executed evidence. Joint hardfork-transition scenarios remain in the separate plan.

- [x] **P9.1 — Deposit and activation queues.** Capture a real pending deposit and a separate
      pending activation; advance, restore each cut, compare the saved queues/validator state and
      activate exactly one imported validator with one deposit log and the expected balance.
- [x] **P9.2 — Consolidation, exit and withdrawals.** Capture pending consolidation and a signed
      exit before inclusion; finish their real delays and payouts, restore and finish again. Verify
      queue identity, balances, actual EL credits and unique withdrawal indices within each branch.
- [x] **P9.3 — External consumer reset/replay.** A separate process with a persisted database must
      consume old and future history. Stop it, restore Panda, recreate provider/nonce caches, clear
      its database and replay from the start. Preserve old records and remove future records.
- [x] **P9.4 — Registration and documentation.** Register the real scenarios/fingerprints and
      document the executable consumer fixture and its ownership/reset order. Record actual runs.

P9.1 passed on `gloas/p3-checkpoint-r5` in **145.41 seconds**. Independent state matched after
restoring the pending deposit at slot **2** and the activation queue at slot **224**. The original
and both restored branches activated validator **64** exactly once at slot **352**, with a **32
ETH** balance, one deposit event and all **65** VC keys/signing records retained. No runtime change
was needed for this coverage; see [scenario](../bakes/gloas/tests/snapshot_deposits.ts) and
[result](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-deposits.json).

P9.2 passed on the same bake in **112.34 seconds**. Capture at slot **8197** retained the pending
consolidation and one signed, not-yet-included exit. The original and restored branches matched: one
exit inclusion, one full EL payout, unique withdrawal indices, zero final exited balance and a
material CL transfer to the consolidation target. Every produced payout block checked the exact EL
account increase against its withdrawals. Mainnet eligibility and withdrawal delays remained
unchanged; this 64-validator fixture explicitly used churn quotients of 4. Both branches reached
slot **24704** and real finality epoch **770**, with EL/CL agreement. See
[scenario](../bakes/gloas/tests/snapshot_withdrawals.ts) and
[result](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-withdrawals.json).

P9.3 passed in **31.83 seconds**. A separate process consumed EL transactions and CL headers through
slot **4** into its own database. After Panda restored slot **1**, that database still held the
discarded future and the transaction sender still cached nonce **2**, while the chain required nonce
**1**. Stopping/resetting/restarting the consumer and recreating the provider/nonce manager replayed
both histories from genesis, preserved the earlier transaction, removed the future and accepted a
different new transaction. See [scenario](../bakes/gloas/tests/snapshot_consumer.ts),
[result](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-consumer.json) and the
[consumer fixture](../bakes/shared/tests/snapshot_consumer.ts). All three scenarios removed their
exact-owner runtime and successful fixture data. All three scenarios are registered in the Gloas
recipe; a regression confirms the external child process participates in the suite fingerprint.
[Consumer reset documentation](lifecycle.md#resetting-an-external-consumer) describes the executable
fixture and reset order. `deno task check` passed; the full unit/adapter suite passed **311 tests
and 122 nested checks**, with **23** opt-in scenarios ignored. P9 is accepted; these standalone
passes do not close P10.

- Test real deposit/activation/consolidation/exit/withdrawal across save and restore, including
  queues, balances and actual EL payouts, with no duplicate inclusion within a branch.
- Deliver a fixture that stops the consumer, restores, recreates provider/nonce caches, clears a
  separate cursor/database and replays from a known deployment/start block or genesis to the
  restored head. The snapshot point does not replace earlier history. A real separate process must
  first consume the discarded future; after replay, assert both preserved pre-snapshot data and
  absence of that future's data.
- Reuse this fixture for the joint transition scenarios once P7/P8 are available. Their additional
  boundary checks are specified in
  [hardfork P9](hardforks-plan.md#p9-verify-snapshots-across-transitions).

Acceptance: an executable snapshot example for CL-dependent tests. External databases are not
rewound automatically, and changes to another project require a separate task.

### P10. Snapshot release verification and documentation

Dependencies: P0–P5 and snapshot P9. Scope: CI/bake/tests. This gate establishes snapshot
capability; joint fork claims additionally require the hardfork plan's P9/P10.

**Status: complete and accepted locally on Gloas/Linux ARM64, October 4, 2026.**

Current verification (October 4, 2026): `deno task check` passed; `deno task test` passed **311
tests and 122 nested checks**, with **23** opt-in scenarios ignored. The Docker/baker gate passed
**4/4** checks in **29 seconds**, including image reuse/archive restoration and exact-owner cleanup.
The full profile started at **13:38:23 UTC**, run ID `8316eab3-3db9-4e11-b8c5-b038b84762f1`, suite
hash `adbcaa27d5111209db8f1521364f04a42e32b6769f7e2e1b9e60b3e3fd109449`. It finished at **14:11:19
UTC**, **19 passed / 0 failed**, in **1,975.949 s**. No native client was rebuilt. The final
[acceptance audit](snapshots-verification.md) maps each requirement to its executed checks. The
existing published client lock predates checkpoint ABI 1; publishing this feature will require the
normal Lighthouse baker 3 release PR, followed by AMD64 Panda verification. Local acceptance does
not claim that publication has happened.

This single run includes all 13 previous scenarios, repeated/faulted/offline snapshots, **11 restore
SIGKILL cuts** (327.75 s), **8 creation SIGKILL cuts** (321.62 s), deposit/activation replay (154.22
s), consolidation/exit/payout replay (133.61 s), and the separate external consumer (36.63 s). Final
independent readback matched the current fingerprint, bake and all 19 report run IDs. No test-owned
Docker containers, networks or volumes remained across 25 recorded owners.

- [x] **P10.1 — Scenario registration.** Nineteen Gloas scenarios are registered, including the six
      snapshot scenarios. Fingerprint checks cover the crash and external-consumer processes.
- [x] **P10.2 — Complete current verification.** The frozen current profile passed 19/19 with exact
      report binding. Unit/static and Docker/baker gates passed. All 43 packaged file hashes and the
      package test hash match the existing successful fixed-image run and current runtime.
- [x] **P10.3 — Measurements.** The current snapshot scenario passed in 91.70 s: capture 17.10 s,
      restore API calls 12.20–13.31 s and next transaction 143 ms. The archive has 11,681,239 file
      bytes and 13,877,248 allocated bytes. Owner allocation before/after capture, after each
      restore and after removal is recorded in the report and [audit](snapshots-verification.md).
      End-to-end API timing bounds maintenance; the exact HTTP outage interval and transient peak
      disk usage are not separately measured.
- [x] **P10.4 — Documentation and final audit.** README/API, lifecycle, consumer reset and release
      prerequisites are documented. The acceptance matrix binds every original contract to checks
      and exact bake/image/schema/ABI evidence. Public evidence excludes private checkout paths and
      credentials. Final review has no unresolved snapshot implementation finding.

- Register snapshot scenarios, fingerprints and capabilities in existing runners. Keep unit/format
  checks distinct from real EL/CL scenarios. Preserve old tags; unsupported capabilities cannot be
  marked passed.
- Run check/test, Docker/baker/lifecycle checks, full applicable profiles for each released Gloas
  bake and the packaged service. Pectra remains deferred; builds and tests stay separate.
- Run real networks sequentially, including honest 1000-slot and fast 8192-slot scenarios and the
  protocol suites. Do not compete with resource measurements.
- Measure capture/restore downtime, snapshot size, additional disk usage and first-transaction
  latency. Do not promise these timings before measuring them.
- Document requirements, snapshot scope/persistence/recovery, immutable schedule compatibility,
  consumer reset, private data handling and actionable errors. Public results omit personal paths
  and secrets.

Acceptance: every snapshot gate is closed and bound to exact bake/image/schema/ABI/schedule/suite. A
successful build or isolated unit suite is not proof of the feature. Fork-transition claims are
accepted separately.

## Failure recovery

| Failure point                              | Required outcome                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before maintenance                         | The active network continues; invalid input does not mutate it.                                                                                          |
| Drain/capture                              | No usable snapshot is published. Resume only from a proven checkpoint; otherwise stop/recovery-required.                                                 |
| Snapshot published, source resume failed   | Retain the usable snapshot and report partial success with a stopped network.                                                                            |
| Restore staged, before commit              | The old generation remains authoritative; the candidate does not sign. Inspect/remove it without blindly starting a faulted source.                      |
| After durable commit                       | The new generation is authoritative. Retry returns its recorded stage/result; restore is not repeated. Recover endpoint publication for that generation. |
| After publish/new signatures               | No automatic rollback. Report cleanup failure separately while retaining the current chain.                                                              |
| Unclean loss with persistent root          | Preserve journal/data, but require an explicit saved snapshot if the active cut cannot be verified.                                                      |
| Ephemeral deployment without retained root | Removing the container removes its data. Durability documentation must use persistent storage.                                                           |

## Source map

- `src/network.ts`, `src/docker.ts`, `src/storage.ts`: open-existing, stop-preserve, generations,
  ownership, inventory and copying.
- `src/controller.ts`, `src/api.ts`, `src/cli.ts`, `src/ingress.ts`, `src/admission.ts`,
  `container/main.ts`, `container/service.ts`, `container/relay.ts`: stable frontends, session
  replacement, operation/recovery APIs and durable mounts.
- `src/config.ts`, `src/profiles.ts`: snapshot capabilities, native ABI and compatibility.
- `src/time.ts`, `src/consensus.ts`, `src/engine.ts`: draining, exact saved time, anchors and
  restart.
- `bakes/*/lighthouse.patch`, `bakes/shared/controlled_clock.rs` and native helpers: persistence,
  checkpoint acknowledgement and parked startup. All native inputs belong in the bake key.
- `bakes/shared/tests`, `bakes/gloas/tests`: real resume/snapshot/protocol/consumer scenarios.
  `tests`: unit boundaries for storage and adapters, not substitutes for real-client evidence.
- `src/verification.ts`, `scripts/test_profile.ts`: suite fingerprints and capability claims.

## Review provenance

The subsequent [external snapshot extension](external-snapshots-plan.md) adds portable file/HTTPS
startup and records its own acceptance. It also records an unresolved source-continuation PTC stall
observed on October 4 after the original acceptance; investigate that runtime observation
separately.

The original revision 4 was approved without blocking findings in three reviews covering
snapshot/state/signing safety, fork/client compatibility and implementation order/API/recovery. This
split preserves those contracts and assigns each check to its feature; it is not a new review or
evidence that planned features work. Actual completed checks are in the P0–P3 report.
