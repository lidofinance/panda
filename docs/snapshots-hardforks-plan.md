# Snapshots and hardfork transitions: implementation plan

Revision 4, reviewed against `main` at `0acee41`, October 2, 2026. This English edition preserves
its design decisions, dependencies and acceptance criteria.

**P0–P3 are complete and accepted locally on Gloas/Linux ARM64.** See the
[validation and review report](snapshots-p0-p3-status.md). Reusable snapshot archives and hardfork
transitions are P4+ and are not implemented yet.

| Stage  | Status                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| P0     | Build inputs and state inventory recorded; clean Geth built and checked.                                     |
| P1     | PTC loss reproduced; behavioral RED and independent reference evidence retained.                             |
| P2     | Generation storage, managed ingress/admission and SDK/CLI/container lifecycle verified.                      |
| P3     | Native r5, cuts 3/31/32/127/128, blob/KZG, checkpoint refusal and continuation verified; full profile 13/13. |
| P4–P10 | Planned; not started.                                                                                        |

Gloas is the only active profile. `src/active_profiles.ts` temporarily excludes Pectra from default
CI, releases and verification. Historical P0–P1 results for both profiles remain available. Electra
and Fulu phases within a Gloas-capable client's schedule remain part of future transition coverage.
All prerequisites below belong to the implementation work, including client research and fixes.

## 1. Intended behavior

A snapshot lets a test prepare the network and protocol once, save them, execute a scenario, restore
the same point and execute another scenario. EL/CL/VC data and protocol time return to the saved
values. Snapshots are reusable and survive process exit when stored persistently.

A transition test defines a schedule before startup, starts at Pectra, crosses Fusaka and then Gloas
in one chain. The clients support all those rules from the start. Crossing a boundary neither builds
an image nor replaces a client binary.

The combined workflow saves before an upgrade, crosses it, tests one outcome, restores and tests
another outcome. Restore does not change the schedule.

Initial scope: controlled Panda networks, mainnet timing, disposable validators owned by the test,
completed slot tails, and the same compatible images/platform. Hot or VM snapshots, baseline mode,
remote signers, cross-host archive transfer, arbitrary database migrations and binary replacement at
a fork boundary are outside this version.

## 2. The PTC persistence defect

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

## 3. Findings and assigned prerequisites

These were the initial findings and risks. Completed fixes are recorded in the validation report;
source inspection alone is not considered verification.

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
- R9: Static profile phases, payload/finality decoding and clock mark ABIs do not provide dynamic
  transitions. P6/P7 separate binary family, active fork and native ABI.
- R10: The earlier research Geth checkout was not proof of the actual image's source. The old binary
  reported revision `5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186` with `vcs.modified=true`. P0 requires
  its complete build diff or a new immutable build from known inputs.
- R11: External providers, oracles and indexers retain reverted events and caches. P9 supplies and
  executes a reset/replay fixture.
- R12: Fast crossing could skip boundary work or overshoot the requested timestamp. P8 validates the
  entire range before mutation and preserves the exact target time.
- R13: The P1 generator's future Fulu schedule with default BPO epochs was rejected by Geth.
  Explicit BPO alignment passed. P6 must compile CL blob schedules, BPO epochs and EL timestamps
  together.

## 4. Design decisions

### 4.1 Capture and restore

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

### 4.2 Storage and lifecycle

- One persistent Panda root holds the journal, active-generation pointer, snapshots and each
  generation's EL/BN/shared/VC data. Container deployments use `/data/panda`; local data stays
  ignored.
- Snapshot-capable sessions bind-mount owned generation directories. Existing runtime volumes are
  not migrated implicitly; capability starts with a new managed network or verified checkpoint.
- Internal dockerd/image caches may be recreated from exact pinned image archives. A snapshot does
  not archive the whole daemon.
- Scoped `Infrastructure` copy helpers preserve permissions and validate owned paths. Every Docker
  mutation is scoped to the exact `io.panda.id` and generation label. Global prune is prohibited.
- Owning SDK `close()` and CLI `down` destroy the active runtime while retaining snapshots. Borrowed
  `close()`/disconnect only closes that connection. `reset` creates a fresh generation.
- Persistent-service SIGTERM performs stop-preserve and a verified checkpoint. A destructive
  `Controller.close()` in `finally` must not erase durable state. Restart follows the active
  pointer. Exhausting the documented shutdown budget or killing the process marks the state unclean.
- Snapshots survive `down`/`reset` and are removed only explicitly.
- A clean stop provides a verified resume checkpoint. After SIGKILL, database files alone are
  insufficient: ingress remains closed and unproven state requires an explicitly chosen saved
  snapshot. There is no hidden rollback.

### 4.3 Ingress, operations and SDK

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

### 4.4 Fork schedule

- Profile/bake selects the binary family; `ActiveFork` is separate status. Existing single-fork
  genesis remains the default.
- A transition network uses Gloas-capable binaries from startup, following Electra/Prague →
  Fulu/Osaka → Gloas/Amsterdam.
- The schedule is immutable after genesis and during restore. One compiler produces CL epochs, fork
  versions and EL timestamps, separate pre-Gloas/Gloas churn constants, and exact uint64 or disabled
  epochs. Actual devnet fork versions are part of identity.
- A new schedule does not require a new image; changed native support requires a new immutable bake.
  The first release never swaps binaries at a boundary.
- Decode historical blocks, states and finalized checkpoints by their own fork/version/slot, not the
  current head's fork.
- Honest transitions are mandatory. Until P8 provides fast crossing, unsupported ranges fail before
  any mutation.

### 4.5 Signatures and external consumers

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

## 5. Stages and acceptance criteria

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
- Run the real genesis generator with future forks and inspect its output. Add focused phase/decoder
  counterexamples for the static controller.
- Reproduce deferred/ambiguous EL outcomes and lost ACK on the selected binary. Proven rejection
  must not block create; unknown acceptance must. Unreproduced research-source risks remain risks.

Acceptance: preserve commands, pin/key and observable failures. Checks without an actual defect are
coverage, not fabricated RED evidence.

### P2. Implement lifecycle, durable storage and managed ingress

Dependencies: P0 and relevant P1 regressions. Scope: controller/Docker.

- Separate initialize-new/open-existing and stop-preserve/destroy. Implement a persistent service
  with replaceable sessions and the SDK/CLI/SIGTERM contracts in section 4.2. Test each entrypoint,
  including owning close deleting only its runtime and borrowed close retaining the shared service.
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

### P6. Compile schedules and generate consistent genesis

Dependencies: P0/P1; independent of the P4/P5 artifact API. Scope: config/genesis.

- Define a typed immutable schedule for supported fork pairs and separate transition capability from
  profile/bake selection.
- Compile CL epochs/versions/blob schedule, BPO epochs, all EL timestamps, separate churn constants
  and exact uint64 values together. Validate Osaka/BPO ordering before Docker mutation; future Fulu
  must not inherit BPO epoch zero.
- Run the real standalone generator, Geth init and exact-version CL state decoder. Prove Electra
  startup and that Fulu/Gloas have not activated early.
- If a component is incompatible, identify it, pin known sources/patches, build a new bake and
  repeat the checks. Never silently select another fork.

Acceptance: consistent EL/CL genesis artifacts with a future schedule. Dynamic Deno transitions are
not a prerequisite for implementing the genesis compiler.

### P7. Implement honest transitions

Dependencies: P6 and required P2/P3 native capabilities. Scope: native/time/consensus.

- Resolve the active fork by slot. Timeline phases and Consensus expectations are dynamic; clock
  marks also depend on the binary's ABI.
- Preflight Engine capabilities for the whole path and apply correct payload/envelope/PTC/finality
  rules. Historical decoding includes pre-fork finalized checkpoints under a post-fork head.
- Add native boundary regressions for PTC service activation before Gloas, domains/cache
  invalidation and proposer/attester/sync duties. Verify the EIP-7044 exception for voluntary-exit
  domains.
- Bake changed native inputs, implement the smallest complete path to the first boundary, then test
  the first and next transitions. Do not require passing a transition before its adapters exist.
- Test Electra → Fulu, Fulu → Gloas and the whole chain separately, with real blob transactions/DA
  around Fulu, protocol operations across boundaries, economics, signing and finality.

Acceptance: transitions in one chain without binary replacement, EL/CL agreement and correct
historical queries. Each advertised pair is tied to tested image identities.

### P8. Implement fast crossing with exact target time

Dependencies: P7. Scope: time/native.

- Until supported, reject the entire unsupported range before changing clocks or VC state.
- Split supported skips at every boundary. Process the last pre-fork slot and first post-fork epoch
  honestly, merging overlapping windows.
- Apply windows only within `[current,target]`; never exceed the requested timestamp. A later fast
  command starting inside a window must still perform its honest portion.
- Reject unsafe starting states before mutation and implement the verified recovery path explicitly.
- Check mid-slot/exact-boundary/multiple-boundary targets, the first transaction, signing and
  resumed finality. Retain existing non-crossing budgets; measure and set a crossing budget before
  optimizing. Honest boundary work does not make all skipped slots penalty-free.

Acceptance: supported crossings preserve exact time; unsupported ranges never execute partially.

### P9. Combine the features and provide a real consumer fixture

Dependencies: P5/P7/P8. Scope: integration/SDK documentation.

- Save before, after and inside boundary windows; transition → restore → repeat transition; read old
  blocks/proofs after a post-fork restore.
- Test real deposit/activation/consolidation/exit/withdrawal across snapshots and forks, including
  queues, balances and actual EL payouts, with no duplicate inclusion within a branch.
- Deliver a fixture that stops the consumer, restores, recreates provider/nonce caches, clears a
  separate cursor/database and replays from a known deployment/start block or genesis to the
  restored head. The snapshot point does not replace earlier history. A real separate process must
  first consume the discarded future; after replay, assert both preserved pre-snapshot data and
  absence of that future's data.

Acceptance: an executable example for CL-dependent tests. Arbitrary external databases are not
rewound automatically, and changes to another project require a separate task.

### P10. Release verification and documentation

Dependencies: all previous stages. Scope: CI/bake/tests.

- Register scenarios/fingerprints/capabilities in existing runners. Keep unit/format checks distinct
  from real EL/CL scenarios. Preserve old tags; unsupported capabilities cannot be marked passed.
- Run check/test, Docker/baker/lifecycle checks, full applicable profiles for each released Gloas
  bake, the packaged service and transition matrix. Pectra remains deferred; builds and tests stay
  separate.
- Run real networks sequentially, including honest 1000-slot and fast 8192-slot scenarios and the
  protocol suites. Do not compete with resource measurements.
- Measure capture/restore downtime, snapshot size, additional disk usage and first-transaction
  latency. Do not promise these timings before measuring them.
- Document requirements, snapshot scope/persistence/recovery, schedules, consumer reset, private
  data handling and actionable errors. Public results must omit personal paths and secrets.

Acceptance: every mandatory gate is closed and bound to exact bake/image/schema/ABI/schedule/suite.
A successful build or isolated unit suite is not proof of the whole feature.

## 6. Failure recovery

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

## 7. Source map

- `src/network.ts`, `src/docker.ts`, `src/storage.ts`: open-existing, stop-preserve, generations,
  ownership and copying.
- `src/controller.ts`, `src/api.ts`, `src/cli.ts`, `src/ingress.ts`, `src/admission.ts`,
  `container/main.ts`, `container/service.ts`, `container/relay.ts`: stable frontends, session
  replacement, operation/recovery APIs and durable mounts.
- `src/config.ts`, `src/profiles.ts`: schedules, capabilities, native ABI and compatibility.
- `src/time.ts`, `src/consensus.ts`, `src/engine.ts`: active fork, barriers, historical decoding and
  time/restart behavior.
- `bakes/*/lighthouse.patch`, `bakes/shared/controlled_clock.rs` and native helpers: persistence,
  parked startup and fork duties. All native inputs belong in the bake key.
- `bakes/shared/tests`, `bakes/gloas/tests`: real resume/snapshot/transition/consumer scenarios.
  `tests`: unit boundaries for config/storage/adapters, not substitutes for client compatibility.
- `src/verification.ts`, `scripts/test_profile.ts`: suite fingerprints, matrices and capability
  claims.

## 8. Plan review

Revision 4 was approved without blocking findings in three reviews: snapshot/state/signing safety;
fork transitions/client compatibility; and implementation order/API/failure recovery. This approval
covers the plan and its acceptance criteria. Executed results, not plan approval, establish which
features work.
