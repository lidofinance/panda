# Panda project plan

Current implementation plans, with prerequisites, status and acceptance criteria:

- [Snapshots](snapshots-plan.md): creation, restore, recovery and consumer reset.
- [Hardfork transitions](hardforks-plan.md): schedules, honest/fast crossing and combined snapshot
  tests.

Snapshot work as of October 4, 2026: **P0–P5, snapshot P9 and P10 are complete locally**.
Independent contract storage, receipt and Beacon SSZ checks, seven persistence failures and eight
real creation process-loss cuts passed. P5 filesystem cleanup, 11 real recovery cuts and persistent
packaged container replacement also passed; its acceptance matrix is reconciled. P9's
deposit/activation, consolidation/exit/payout and external consumer reset/replay scenarios passed
and are registered. The final current Gloas profile passed **19/19** in **32 min 56 s**, with
unit/static, Docker/baker, current packaged-service and measurement gates also passed. See the
[final snapshot acceptance report](snapshots-verification.md). Publication needs the normal
Lighthouse baker 3 release PR and AMD64 verification; dynamic fork work remains in its separate
plan.

Current P0–P3 acceptance, completed checks and audit:
[verification report](snapshots-p0-p3-status.md).

Recorded status as of September 29, 2026. The first working version was implemented and verified on
macOS arm64 with Docker Desktop. The current priority is to consolidate the selected stable version.
Further optimization was paused at the user's request; the later stages below remain possible future
work. The results in this document describe those earlier runs.

## Completed

- [x] Real Pectra network: unmodified Geth, a Lighthouse BN/VC fork, 64 genesis validators and a
      one-shot ethereum-genesis-generator. Source versions and images are pinned.
- [x] One TypeScript/Deno controller, with Docker managed through dockerode, without Compose or
      Kurtosis.
- [x] Protocol time is separate from real network deadlines and JWT time. The head remains unchanged
      while paused.
- [x] Forward time controls by duration and date: `advanceTime` and `advanceTo`. The API also
      includes `stepSlot`, `advanceSlots`, `advanceEpochs`, bounded `advanceUntil` and explicit
      `skipSlots`.
- [x] Ordinary advancement performs real blocks, signatures and attestations. Finalization was
      checked by comparing the execution hashes of the Beacon finalized checkpoint and Geth's
      finalized block.
- [x] Automine handles concurrent sends, nonce gaps and low fees. HTTP JSON-RPC preserves responses,
      errors, batch and notification semantics.
- [x] Twenty dependent deployments through raw RPC and `ethers.ContractFactory` were checked. Each
      enters the next block without manual time commands. The checks cover constructors, runtime
      code, timestamps and receipt latency; fast ethers settings are documented in the usage guide.
- [x] Deposit, activation of a new key, signed exit, actual withdrawal and consolidation scenarios
      passed. Consolidation explicitly overrides the churn quotient; ordinary profiles retain
      standard delays and churn.
- [x] TypeScript API, CLI `up/down/reset/diagnose`, e2e examples and a separate test indexer.
- [x] Repeated commands, reproducible genesis, protection against a second owner, startup rollback
      and cleanup limited to the selected instance were checked.
- [x] Five initial agent skills and `AGENTS.md` were created and used. Review fixes received a
      separate verification pass. Lighthouse compilation is separate from network startup.
- [x] The initial opt-in Pectra suite passed 14 tests in 6 minutes 10 seconds, covering time, exit
      to withdrawal, deposit/activation/consolidation and sequential deployment. Rust clock
      regression and CLI lifecycle checks also passed separately.
- [x] An ordinary network and two controlled-network runs were measured, including component
      CPU/RAM, disk, slot advancement speed and build cost.

The initial Pectra measurements were 10–11 seconds to readiness with empty databases and cached
images, about 2.86 slots/second, and about 545 MiB while paused including the controller. The full
exit-to-withdrawal scenario with long skipped periods took 99.9 seconds. These are measurements of
one host, not a performance promise for another machine.

## Bake profiles

- [x] Hardfork-named profiles: `pectra` and `gloas`, with separate tags within each profile.
- [x] The baker pins source commits, clock patches, toolchains, Docker image IDs and platform.
- [x] Prebuilt EL images and Geth source builds are supported. Lighthouse uses the selected
      profile's patch. Tags are published atomically; identical inputs reuse cached artifacts.
- [x] API/CLI startup selects an existing bake without compiling. Runtime uses profile-specific
      genesis, Engine API, Beacon API and validator duty schedules.
- [x] Each profile defines its complete scenario list. Gloas also checks its separate execution
      envelope, bid and real PTC votes.
- [x] Verification binds the bake key and suite fingerprint. Old or mixed results do not receive
      `verified` status.
- [x] Profile checks are independent. Selected scenarios and their runtime have their own
      fingerprint; new client sources do not invalidate verification of an already built image.
      Shared `test:baker` runs separately. Native tests use their bake key's source archive.
- [x] `e2e:warp` covers two 8192-slot jumps, real transactions after each jump, resumed finality,
      the entire validator registry and signing history.
- [x] The simpler v3 was selected at the user's request and pinned as `gloas/stable`. The v4/v5
      experiments were excluded from the current patch and further optimization was paused. Earlier
      jumps including a transaction took 9.7 / 11.9 seconds; the regression threshold is 20 seconds.
- [x] The full `gloas/stable` suite passed 8/8 checks with `verified: true`; the two jumps including
      transactions took 10.8 / 11.6 seconds. A separate `pectra/default` warp check passed on the
      final runtime: 17.6 / 18.3 seconds. Both profiles resumed finality after two jumps; all 64
      validators continued signing without slashing or conflicts. The full Pectra suite was not
      rerun.

Commands, import restrictions and adding client versions are described in [bakes.md](bakes.md).
Current verification results are stored in `reports/profiles/<hardfork>/<tag>/verification.json`.
These are correctness checks; their duration while compilation is running is not a benchmark.

## Remaining measurement work

- [ ] Measure a complete cold start on a clean environment without cached images: downloads, build,
      genesis, readiness and the first block separately. Existing measurements use empty databases
      with cached images.
- [ ] Compare Geth cache sizes and CPU limits under the same load. Measure peak memory and disk
      growth over a longer run. Current settings have measurements but are not proven optimal.

## Next priorities

1. **Strengthen time and failure checks.** Add real e2e coverage for fractional timestamps, long
   advancement across epoch boundaries, concurrent time commands, extended pauses and EL/BN/VC
   failure during a phase. Acceptance requires EL/CL agreement, no spontaneous blocks and a clear,
   bounded error when advancement cannot complete.
2. **Protect EngineGate compatibility.** Automate checks for missing or changed payload-readiness
   events, expired JWTs and incompatible Geth images. The proxy currently depends on a particular
   Geth version's JSON log; upgrades require another source review.
3. **Verify installation from scratch and other platforms.** Install the required Deno version, then
   run build and e2e checks in a clean environment, then on Linux arm64/amd64. Add CI with fast
   checks and separate Docker/Rust jobs. Complete the cold-start measurement and verify that built
   images match their sources and patches. Only macOS arm64 with Docker Desktop has been confirmed
   so far.

Controlled Gloas bakes declaring `checkpointAbi: 1` now support clean stop and cold resume with the
same compatible bake. Unclean data is refused. See
[stop/resume and persistent storage](lifecycle.md) for the API, ownership and shutdown semantics.

## Possible later extensions

- WebSocket JSON-RPC and long-lived Beacon SSE for services that need more than HTTP.
- Multiple beacon nodes, external validators and transitions between Ethereum forks, with separate
  scheduler changes and e2e coverage.

These extensions are not implemented or included in the first version's verified capabilities. The
baker deliberately retains images and compiler-cache volumes. Scenarios remove only their own
instance's containers, networks and data; global Docker cleanup is never performed.

Details: [architecture](architecture.md), [measurements and verification limits](measurements.md),
[review results](review.md), [raw reports](../reports).
