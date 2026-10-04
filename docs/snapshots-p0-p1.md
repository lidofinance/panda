# P0–P1: pinned builds, state inventory and regressions

Historical checkpoint: 2026-10-02, based on `main` at `0acee41`. This records the preparatory stages
of the [plan](snapshots-hardforks-plan.md), before P2–P3 implementation. For completed work and
current limits, see the [P0–P3 verification report](snapshots-p0-p3-status.md). The failures below
remain evidence about the original builds; they are not the status of the final r5 bake.

Checks used Deno 2.9.7 and Docker on `linux/arm64`. Original logs and network data are in ignored
`.cache/p0-p1/` and `.panda/`. Public measurements are in
[reports/snapshots/p0-p1.json](../reports/snapshots/p0-p1.json).

`deno task check` passed. The ordinary suite reported **109 passed, 0 failed, 13 ignored**. The main
real E2E passed on both clean EL compositions through slot 129 / finalized epoch 2 with EL/CL
agreement. These were individual checks, not complete `test:profile` runs.

## Reproduced defect

The pinned Gloas BN lost PTC votes during normal shutdown. The regression advances two networks with
the same genesis and bake through three identical slots. One continues uninterrupted; the other
preserves client data, stops and recreates the clients at the same protocol time. It compares the
next signed block, including aggregation bits and state root.

- BN/VC restart with EL still running: **FAIL**. Block 4 contained an empty PTC list instead of 512
  committee positions.
- EL/BN/VC restart: **FAIL**, with the same difference.
- The block before shutdown matched. After restart, block 4 was produced and EL/CL agreed. RPC
  availability or head growth alone would therefore have missed the loss.
- The only block-body difference was `payload_attestations`, which also changed the state root.
- Pectra passed both complete next-block comparisons at this cut. That observation did not certify
  arbitrary Pectra recovery.

A native test on the exact pinned Gloas Lighthouse reproduced the cause independently of Docker.
Normal gossip verification accepted real BLS messages; the verified aggregate covered all 512
positions, including repeated validator indices. After production
`PersistedOperationPool::as_store_bytes/from_store_bytes`, the aggregate was empty. The failure was
an assertion after the round trip, not a build or fixture error.

A second native test passed. Attestation votes entered the fork-choice queue, and the operation
called by the state-advance timer at the slot tail processed them. Fork-choice slot became `N+1`
while protocol slot remained `N`. In this fixture, the persistent pool already covered all naive
attestation votes, and the sync aggregate retained 512 positions after serialization. This did not
justify persisting every cache: incomplete delivery must instead cause a coverage check or refusal.

## Why earlier checks missed it

`bakes/gloas/tests/gloas.ts` checked PTC in a running network without a BN restart or pool round
trip. The original `bakes/shared/tests/lifecycle.ts` checked fresh start/down/reset, with down
deleting data. Fast warp restarted VC while BN and its PTC pool stayed in memory. These scenarios
could pass while cold restart lost state.

This was a coverage gap for the new lossless-resume requirement, not evidence that uninterrupted
execution was broken. The regressions defined observable acceptance criteria for P3 persistence and
parked startup, subsequently implemented and checked in the current report.

## Pinned inputs

Immutable manifests record complete IDs, digests, platforms, native source hashes and recipes:

| Profile | Original bake                                            | Clean EL composition                                 |
| ------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Gloas   | [ci-main-merge](../bakes/gloas/tags/ci-main-merge.json)  | [p0-clean-el](../bakes/gloas/tags/p0-clean-el.json)  |
| Pectra  | [ci-main-merge](../bakes/pectra/tags/ci-main-merge.json) | [p0-clean-el](../bakes/pectra/tags/p0-clean-el.json) |

- Gloas CL: `2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`, upstream 8.2.2.
- Pectra CL: `cfb1f7331064b758c6786e4e1dc15507af5ff5d1`, upstream 7.1.0.
- Original Gloas EL: `5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186`, Go 1.27.1, `vcs.modified=true`. The
  binary cannot reveal the complete dirty diff. A new EL was built from that full commit using the
  existing baker, without additional patches, on Go 1.25.14 with `vcs.modified=false`: image
  `sha256:549317edd21bb0e720bf53459e353f4eee30acd3a99a89380f762c0b6cfe0e7e`.
- Original Pectra EL: `36b2371c59cd91a9b1da062b3e382f05a6d8687e`, Go 1.24.2, `vcs.modified=true`. A
  previously built clean binary of the same commit was reused from
  [geth-source](../bakes/pectra/tags/geth-source.json), image
  `sha256:3f3d4a82b71796278b66f6f571bc7d3d52616df0a77c79b4c4cc51a5613be70e`. Build metadata was
  rechecked: `vcs.modified=false`.
- Lighthouse was not rebuilt. Each composition records the existing image in `source.importedCl`;
  its native provenance comes from the corresponding `ci-main-merge`, not from successful import.
  Existing manifests, default tags and release workflows were unchanged by this investigation.
- These clean EL compositions were local, unpublished and not fully profile-verified at this stage.
  Individual E2E success did not replace the release suite.

The Gloas genesis image was checked as a collection of separate tools:

| Component                                            | Verified source                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `generate_genesis.sh`, `defaults.env`, `config.yaml` | Byte-for-byte match with `51fb77af3ad017ab2ae14a6e69246fe95453cdd2`                         |
| `eth-genesis-state-generator`                        | Go VCS revision `9bbbf55fa9603b4c2e656fe7c441a340ea61f6d6`, modified=false                  |
| Complete image                                       | Manifest ID/digest; shell provenance does not establish provenance of every embedded binary |

Pectra shell/defaults/config matched `f06b98c2cb789c6ac45fd0e6167173820dc095d2` byte for byte. Its
embedded `eth-beacon-genesis` reported revision `f6489518ba1e70bd8b073387119692f264b3b368`,
`vcs.modified=false`.

## State inventory and checkpoint obligations

The decisions apply to both profiles unless stated otherwise. Completion requires observable
acknowledgement rather than an arbitrary delay; without it, save must fail. This inventory defines
P2–P5 obligations, not a claim that every API existed at this historical checkpoint.

| State                                                                                          | Required action                                                                                        | Check before checkpoint publication                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| EL chaindata, trie/state history, ancients/freezer, snapshots and canonical/finalized pointers | Preserve the complete owned datadir after clean stop                                                   | Actual head/finalized hashes, chain configuration and database availability on open                                                   |
| EL blobpool, sidecars, transaction journals and local transaction tracker                      | Preserve the datadir; unfinished user transactions block save                                          | No pending/queued transactions or unresolved accepted/unknown submissions; an empty txpool alone is insufficient                      |
| Genesis JSON/SSZ, CL configuration, fork versions, timing/constants and JWT                    | Preserve immutable generation inputs                                                                   | Input hashes, genesis roots, schedule, chain ID and image IDs match                                                                   |
| BN hot/cold DB, states/blocks, blob/data-column DB, freezer and split point                    | Preserve together                                                                                      | EL/CL anchors, canonical state and required DA are available                                                                          |
| Fork-choice proto-array, votes, checkpoints, balances and store                                | Persist                                                                                                | Actual roots and fork-choice slot; protocol slot is not a substitute                                                                  |
| Queued fork-choice attestations                                                                | Complete at the agreed slot tail, or explicitly persist/refuse                                         | Queue contents are empty after native completion; a clock mark alone is insufficient                                                  |
| Attestation operation pool                                                                     | Persist                                                                                                | SSZ round trip, required data/signatures and next-block inclusion                                                                     |
| Naive attestation pool                                                                         | Transfer verified votes into the persistent pool without producing a block, or prove coverage/refuse   | Every required vote is covered; the complete-tail fixture passed                                                                      |
| Sync contributions in the operation pool                                                       | Persist                                                                                                | Aggregate data/signature and every required next-block committee bit                                                                  |
| Naive sync pool                                                                                | Reconstruct from persisted verified contributions without new signatures, only when coverage is proven | Partial coverage cannot be declared complete; preserve missing data or refuse                                                         |
| Gloas PTC messages                                                                             | Add persistence in P3                                                                                  | Nonempty pool survives serialization; next-block data, signatures and all 512 positions match                                         |
| Voluntary exits, BLS changes and proposer/attester slashings in the operation pool             | Preserve with native fork/verification metadata                                                        | State distinguishes pending operations from included operations retained until pruning/finality; a missing persisted pool is an error |
| Deposits, consolidations, exits and withdrawals already in consensus state                     | Preserve in BN DB                                                                                      | Queues need not be emptied; subsequent processing must match                                                                          |
| Pending execution envelopes, DA checker, unverified blocks/payloads and custody work           | Complete observably or refuse                                                                          | No unfinished verification/import/delivery; canonical payload and DA are available                                                    |
| Custody context, column assignments and validator registration state                           | Preserve native durable context                                                                        | Consistent with genesis/spec and required columns on open                                                                             |
| Beacon state/committee/reward caches, prepared-skip state and cached duties                    | Reconstruct from a verified checkpoint                                                                 | No new signature, time shift or fabricated completion                                                                                 |
| VC keystores, passwords, validator definitions, fee recipients and enabled state               | Preserve the entire owned directory                                                                    | Exact key/definition set; missing files never trigger fresh genesis                                                                   |
| VC slashing DB, journal/WAL and signing history                                                | Preserve atomically after stop                                                                         | DB is mandatory; no `--init-slashing-protection` on restore; existing records remain                                                  |
| Volatile VC duty caches and completion marks                                                   | Reconstruct during parked startup                                                                      | No repeated/conflicting signatures before ingress opens; no manually fabricated marks                                                 |
| Controller clock, active generation, session configuration and lifecycle status                | Versioned manifest/journal                                                                             | Exact `nowMs`, matching native clocks and recorded prior incomplete operation                                                         |
| Automine/Timeline queue, active RPC, SSE and EL admission intents/results                      | Drain ingress and preserve durable intents; unknown outcomes block create                              | No save race; operation result/ID persists; restore remains available from a faulted state                                            |
| EngineGate pending payload IDs and readiness promises                                          | Complete work; recreate the gate without in-flight Engine requests                                     | New EL binding, real log events and JWT                                                                                               |
| Sockets, host ports, process IDs, locks and Docker handles                                     | Recreate                                                                                               | Current-generation ownership; stable public URLs through managed frontends                                                            |
| External oracle/indexer/provider caches and filters                                            | Outside the snapshot; explicit reset/reconnect in P9                                                   | Consumers do not treat the discarded branch as current                                                                                |
| Unknown native operations or unsupported schema/ABI                                            | Refuse save/restore                                                                                    | An explicit error replaces silent loss or fresh initialization                                                                        |

## Historical capabilities and version contracts

At P0–P1, `Bake.schema=1` did not imply snapshot support. The clock ABI was identified by namespace
`PANDA`, exact native hashes and `clockWait/directSync/preparedSkip` flags, without a checkpoint ACK
or parked-restore contract.

The plan reserved separate `snapshot.schema=1` and `checkpointAbi=1` versions and explicit native
capabilities. The snapshot manifest must bind image IDs/platform, bake key, genesis/spec/schedule
hashes and inventory. Mismatches or missing capabilities require refusal.

| Capability on 2026-10-02                         | Pectra          | Gloas               | Acceptance condition                                |
| ------------------------------------------------ | --------------- | ------------------- | --------------------------------------------------- |
| Ordinary controlled network                      | Supported       | Supported           | Existing profile suite                              |
| Cold next-block equality at the investigated cut | Observed PASS   | Reproduced PTC loss | Diagnostic result, not a general capability         |
| Verified checkpoint / parked startup             | Not implemented | Not implemented     | P2–P3: positive ACK, readback and continuation      |
| Snapshot create/restore                          | Not implemented | Not implemented     | P4–P5: crash/failure and repeated restore tests     |
| Hardfork transitions                             | Not implemented | Not implemented     | P6–P8: active-fork dispatch and real crossing suite |

P2–P3 Gloas support has since passed the [current acceptance checks](snapshots-p0-p3-status.md).

## Fork schedule and admission findings

The actual generator supports Electra genesis with Fulu at epoch 2 and Gloas at epoch 4. It produced
EL timestamps `2000000768` and `2000001536`; the common genesis SSZ prefix confirmed slot 0 and the
Electra fork version. With default `BPO_1_EPOCH=BPO_2_EPOCH=0`, however, Geth rejected
initialization:

```text
unsupported fork ordering: osakaTime enabled at timestamp 2000000768, but bpo1 enabled at timestamp 0
```

Explicit `BPO_1_EPOCH=2` and `BPO_2_EPOCH=3` made the repeat pass. P6 must compile the entire
schedule, including BPO, the CL blob schedule and EL timestamps, rather than forwarding three fork
epochs. Correcting this diagnostic input did not implement a Panda schedule compiler.

Three controller counterexamples established P7 requirements: the Gloas family requested an envelope
for an Electra block, decoded a pre-Gloas finalized checkpoint incorrectly, and selected a Gloas
attestation mark despite an Electra phase table. These tests isolate adapters; HTTP fixtures are not
evidence of real-client fork compatibility.

The admission scenario ran on both original and clean Gloas EL builds:

- A malformed transaction was rejected without changing the pool.
- A fee-capped transaction received a hash and no receipt; it was not rejected.
- A transaction accepted by Geth executed after its response was lost, without resubmission.
- All 80 nonce-gap transactions received successful hash responses. After queue eviction, 16 were
  absent from `txpool_content`, `eth_getTransactionByHash` and receipts. Absence from the pool
  therefore does not prove rejection before admission.

These observations defined the P2 ledger: proven terminal rejection may settle an intent, while
accepted/unknown outcomes remain unresolved. Checks against snapshot creation belong to the actual
P2/P4 APIs; a nonexistent API was not used as artificial RED evidence.

## Historical reproduction commands

These commands identify the original diagnostic inputs. Use the recorded source revision to
reproduce the historical assertions; maintained tests may have gained later acceptance checks.
`ci-main-merge` selects original artifacts; `p0-clean-el` selects clean EL compositions.

```sh
deno task check
deno task test
PANDA_PROFILE=pectra PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/restart.ts cl
PANDA_PROFILE=pectra PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/restart.ts all
PANDA_PROFILE=gloas PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/restart.ts cl
PANDA_PROFILE=gloas PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/restart.ts all
PANDA_BAKE=ci-main-merge deno run -A bakes/gloas/tests/restart_native.ts
PANDA_BAKE=ci-main-merge deno run -A bakes/gloas/tests/fork_genesis.ts
PANDA_BAKE=ci-main-merge deno run -A bakes/gloas/tests/fork_genesis.ts --aligned-bpo
deno test -A bakes/shared/tests/fork_controller_test.ts
PANDA_PROFILE=gloas PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/admission.ts
PANDA_PROFILE=gloas PANDA_BAKE=p0-clean-el deno run -A bakes/shared/tests/admission.ts
PANDA_PROFILE=gloas PANDA_BAKE=p0-clean-el deno run -A bakes/shared/tests/e2e.ts
PANDA_PROFILE=pectra PANDA_BAKE=p0-clean-el deno run -A bakes/shared/tests/e2e.ts
```

On the original Gloas Lighthouse, restart/native PTC assertions are expected to fail. The genesis
probe without BPO overrides demonstrates Geth refusal; `--aligned-bpo` passes. The three controller
counterexamples remain unresolved until P7. Do not replace lossless assertions with assertions that
expect data loss merely to obtain green results.

The native runner uses archived patch/clock inputs from the selected bake and a separate current
regression test, records every source hash and uses the pinned Rust builder. It builds a test
executable under ignored `.cache/`, without rewriting the bake or building a new Lighthouse image.

At this historical stage, lossless resume, durable snapshots, fault recovery, user CL operation
preservation, fork crossing and oracle combinations were not implemented or verified. Subsequent
P0–P3 acceptance is recorded separately; reusable snapshots and transitions remain future work.
