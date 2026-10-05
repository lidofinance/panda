# Hardfork transitions: implementation plan

Split from revision 4 of the combined plan, reviewed against `main` at `0acee41` on October 2, 2026.
This plan owns scheduled fork activation and honest/fast crossing in one chain. Reusable snapshot
creation and restore are covered by the separate [snapshot plan](snapshots-plan.md).

**Dynamic hardfork transitions are not implemented or verified yet.** Gloas is the only active
profile; Pectra releases and default CI remain paused. This does not exclude Electra and Fulu phases
inside a transition network that uses Gloas-capable binaries.

Original stage IDs are retained for traceability. P0–P5 belong to the snapshot plan. P6–P8 are the
transition implementation. P9 is the joint snapshot/transition gate. P10 verifies the transition
release; the snapshot plan has its own release checks.

| Stage                                 | Status                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Shared P0–P3 baseline                 | Complete locally for Gloas/Linux ARM64; evidence is a prerequisite, not transition certification. |
| P6 — schedule compiler and genesis    | Planned; generator/BPO and controller counterexamples are already recorded.                       |
| P7 — honest transitions               | Planned; not started.                                                                             |
| P8 — fast crossing                    | Planned; not started.                                                                             |
| P9 — snapshots across transitions     | Planned; also depends on snapshot P5 and its consumer fixture.                                    |
| P10 — transition release verification | Planned; not started.                                                                             |

## Intended behavior and scope

A test defines an immutable schedule before startup, begins with Electra/Prague (Pectra), crosses
Fulu/Osaka (Fusaka) and then Gloas/Amsterdam in the same chain. The exact clients must support every
scheduled rule from startup. Reaching a boundary neither builds an image nor replaces a binary.

Both honest advancement and explicitly requested fast crossing must select the correct fork
behavior. Historical block/state/finality queries continue to use the fork of the queried data. The
existing single-fork genesis remains the default.

Scope: controlled Panda networks, mainnet timing, real EL/CL/VC clients and disposable development
validators. Binary replacement at a boundary, arbitrary client/database migrations, baseline mode,
remote signers and unverified client pairs are outside this version.

P6–P8 can be implemented and verified without the reusable snapshot API. Saving before a boundary,
crossing it, restoring and repeating is the additional joint P9 scenario. Restore never changes the
schedule; the snapshot plan owns archive integrity, generations and recovery.

## Prerequisites and existing evidence

- Use exact pinned image IDs, platform, genesis inputs and native capabilities from
  [P0–P3](snapshots-p0-p3-status.md). The verified clean lifecycle/admission/checkpoint baseline
  must remain intact. New native changes require new immutable bakes and their own checks.
- P1 ran the actual generator with Electra genesis, Fulu at epoch 2 and Gloas at epoch 4. It
  produced EL timestamps `2000000768` and `2000001536`. Default `BPO_1_EPOCH=BPO_2_EPOCH=0` caused
  Geth to reject fork ordering; explicit BPO epochs 2 and 3 passed. This is genesis evidence, not a
  completed Panda schedule compiler or a real transition.
- Three controller counterexamples identified static assumptions: requesting a Gloas envelope for an
  Electra block, decoding pre-Gloas finality incorrectly and selecting the Gloas attestation mark
  for Electra phases. Adapter fixtures do not prove real-client compatibility.
- Preserve this evidence and add behavioral regressions before implementing each affected path.
  Missing APIs, build failures and fixture errors are not behavioral RED. Client incompatibilities
  must be investigated and fixed within the assigned stages.

Details and original commands are in
[P0–P1](snapshots-p0-p1.md#fork-schedule-and-admission-findings). Snapshot creation/restore is
required only for joint P9, not for genesis compilation or standalone crossing tests.

## Findings assigned to this plan

Original finding IDs are retained:

- R9: Static profile phases, payload/finality decoding and clock mark ABIs do not provide dynamic
  transitions. P6/P7 separate binary family, active fork and native ABI.
- R12: Fast crossing could skip boundary work or overshoot the requested timestamp. P8 validates the
  entire range before mutation and preserves the exact target time.
- R13: The P1 generator's future Fulu schedule with default BPO epochs was rejected by Geth.
  Explicit BPO alignment passed. P6 must compile CL blob schedules, BPO epochs and EL timestamps
  together.

## Design decisions

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

Protocol time controls fork activation; RPC deadlines, watchdogs, sockets and JWT continue to use
real time. Keep real signature validation, execution checks, duties, validator economics and
finality. No fabricated checkpoints, manual completion marks or verification bypasses.

## Stages and acceptance criteria

### P6. Compile schedules and generate consistent genesis

Dependencies: shared P0/P1 evidence; independent of the snapshot P4/P5 API. Scope: config/genesis.

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

Dependencies: P6 and the shared P2/P3 lifecycle/native baseline. Scope: native/time/consensus.

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

### P9. Verify snapshots across transitions

Dependencies: P7/P8 plus [snapshot P5 and its P9 consumer fixture](snapshots-plan.md). Scope: joint
integration. This owns the cross-feature portion of original P9.

- Save before, after and inside boundary windows; transition → restore → repeat transition; read old
  blocks/proofs after a post-fork restore. Verify exact saved time and the unchanged schedule.
- Test real deposit/activation/consolidation/exit/withdrawal across both snapshots and fork
  boundaries, including queues, balances and actual EL payouts, with no duplicate inclusion within a
  branch.
- Reuse the snapshot consumer reset/replay fixture. A separate process first consumes the discarded
  post-fork future; after restore and replay, it retains the valid pre-snapshot history and no
  discarded future. Provider/nonce caches, cursor/database, subscriptions and session IDs must be
  reset through the documented fixture.

Acceptance: repeatable boundary crossings after restore, correct historical data and an executed
CL-dependent consumer example. Do not claim this capability from separate snapshot and transition
passes alone. Changes to another project require a separate task.

### P10. Transition release verification and documentation

Dependencies: P6–P8 for standalone transition support; P9 is additionally mandatory for joint
snapshot/transition support. Scope: CI/bake/tests. Snapshot release checks remain in its own plan.

- Register transition scenarios, supported pairs, fingerprints and capabilities in existing runners.
  Keep unit/format checks distinct from real EL/CL scenarios. Existing tags stay immutable;
  unsupported pairs or capabilities cannot be marked passed.
- Run check/test, Docker/baker/lifecycle checks, full applicable profiles for each released Gloas
  bake, the packaged service and the transition matrix. Pectra remains deferred; a Gloas-capable
  network's earlier fork phases still require real crossing coverage.
- Run real networks sequentially, including honest 1000-slot and fast 8192-slot regressions and
  protocol suites. Do not compete with resource measurements. Build clients separately from tests.
- Verify each advertised fork pair, full Electra → Fulu → Gloas path, honest/fast modes, blob/DA,
  economics, signing history, historical queries, next transaction and resumed finality. Joint
  snapshot claims additionally require the P9 matrix on the same compatible artifacts.
- Measure boundary-window and first-transaction latency; establish fast crossing budgets before
  optimization. Do not promise timings before measuring them.
- Document schedule inputs, supported pairs, native ABI requirements, honest/fast behavior, exact
  target time, actionable refusals and verified limits. Link the snapshot plan's recovery/consumer
  contract for combined use. Public results omit personal paths and secrets.

Acceptance: each advertised capability is bound to exact bake/image/platform/ABI/schedule/suite,
plus snapshot schema for joint restore scenarios. A build, adapter suite or successful genesis
initialization alone does not establish a working transition.

## Failure behavior

- Validate the complete schedule, Osaka/BPO ordering and Engine/native support before creating or
  mutating the network.
- Reject an unsupported fast range before changing protocol clocks or VC state; never execute only
  its supported prefix or overshoot the requested target.
- A failure during actual supported advancement is explicit and leaves the network faulted; no
  fabricated completion, silent fork substitution or automatic binary swap is allowed.
- Recovery with a saved snapshot follows the snapshot plan's journal and generation rules. It
  requires the implemented snapshot capability; there is no implicit rollback or fresh genesis.

## Source map

- `src/config.ts`, `src/profiles.ts` and genesis configuration: typed schedule, fork versions,
  timestamps, capabilities, native ABI and validation.
- `src/time.ts`, `src/consensus.ts`, `src/engine.ts`: active fork, dynamic phases, envelope/PTC
  rules, historical decoding and exact target time.
- `bakes/*/recipe.json`, `bakes/*/lighthouse.patch`, `bakes/shared/controlled_clock.rs` and native
  helpers: pinned support, boundary duties, domains and caches. Native inputs belong in the bake
  key.
- `bakes/shared/tests`, `bakes/gloas/tests`: real genesis, crossing, protocol and combined consumer
  scenarios. `tests`: schedule/adapter boundaries, not substitutes for client compatibility.
- `src/verification.ts`, `scripts/test_profile.ts`: supported-pair matrices, fingerprints and
  capability claims. Public SDK/CLI expose the immutable schedule and active-fork status.

## Review provenance

The original revision 4 received three reviews covering snapshot/state/signing safety, fork/client
compatibility and implementation order/API/recovery. This document separates the transition work
without claiming a new review or completed transition tests. Shared P0–P3 success does not close any
unexecuted crossing gate.
