# Gloas: PTC and attestation persistence across cold restart

Historical checkpoint: 2026-10-02. This records the first persistence fix for the defect reproduced
in [P0–P1](snapshots-p0-p1.md), part of [P3](snapshots-hardforks-plan.md). It did not by itself
implement a public snapshot API or complete P3. The later lifecycle, admission and checkpoint work
is covered by the [current P0–P3 verification report](snapshots-p0-p3-status.md).

## Cause and fix

In pinned Lighthouse `2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`, `payload_attestation_messages`
existed only in memory. Normal operation-pool persistence omitted it, and loading created an empty
pool. The first block after BN restart therefore lost votes for the previous slot's payload. Head
growth and EL/CL agreement still worked, but the block body and state root differed from an
uninterrupted network.

The [persistence format](../bakes/gloas/native/persistence.rs) adds the original verified PTC
messages—validator index, data and signature—to the same stored operation pool. Loading reinserts
them through the normal Lighthouse method. Existing client logic constructs the next aggregate; this
matters because one validator can occupy multiple positions in the 512-member PTC. No fabricated
aggregate or signature bypass is used.

Extended testing found another loss: after stopping at slot 32, block 33 lacked an ordinary
attestation even with PTC preserved. Verified votes in `naive_aggregation_pool` enter the operation
pool during production of the next block. If the aggregator has not published
`SignedAggregateAndProof`, stopping before that block leaves those votes outside the stored pool.
The [patch](../bakes/gloas/patch_checkpoint.py) transfers verified attestations into the operation
pool before `persist_op_pool()`, using the production path for block construction. Participant
indices come from state, and transfer errors propagate. No extra block is produced; head and
protocol time remain unchanged.

The record has magic `PANDAOPPOOL`, version `1` and a SHA-256 checksum of its SSZ body. Unknown
versions, truncated/corrupt records and duplicate data/validator-index pairs cause errors rather
than an empty pool. The checksum detects integrity failures; it does not protect against an
administrator who can rewrite the record and its checksum. Other operation-pool fields remain in the
same database record.

Legacy V20 records remain readable, but their already-lost PTC cannot be recovered. An older
Lighthouse cannot read the new format, so binary rollback on the same datadir is unsupported.
Reproducible testing uses a new network and immutable bake instead of replacing a client inside an
existing tag.

This historical change raised Gloas `bakerVersion` to `2`. Patch and native tests are part of build
identity; existing manifests and published images were not rewritten. Pectra was unchanged. The
later complete checkpoint bake uses baker 3.

## Executed evidence

Private logs and network data are under ignored `.cache/p3/` and `.panda/`. Public identities and
measurements are in
[reports/snapshots/p3-persistence.json](../reports/snapshots/p3-persistence.json).

- The regression on old `ci-main-merge` failed specifically because PTC was lost after production
  StoreItem serialization. This was behavioral RED, not a compilation failure.
- Four native tests passed with the fix: real BLS signatures and all 512 PTC positions survived
  serialization and database write/read through `chain.persist_op_pool()`; sync contributions and
  required votes survived; legacy records loaded; corrupt and unknown versions were refused.
- An additional regression first failed on lost verified naive votes and then passed after the
  transfer-before-persistence fix. It uses slot 32, real gossip verification and no aggregator
  messages; head remains unchanged.
- An injected MemoryStore write failure propagated from `persist_op_pool()` and preserved the prior
  record. This tests database error handling, not disk power-loss recovery.
- `deno task check` passed. Ordinary tests reported 114 passed, 0 failed, excluding Docker/E2E.

| Historical build                      | Identity and result                                                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p3-ptc`                              | BUILD PASS on `linux/arm64`; key `d058ec809875f8da6e5f20468711d2fba232f9d1ccbff7defa2517a42c6b8ad1`; CL image `sha256:c24f18add57879ebe271048df832cc9bfb7711866d81d6bc77e2c6fc4d8c01be` |
| Original cut 3 on `p3-ptc`            | BN/VC restart PASS and EL/BN/VC restart PASS; signed block 4 matched the independent uninterrupted network completely                                                                   |
| Extended cut 32 on `p3-ptc`           | FAIL: block 33 lost the slot-32 attestation; this bake was not accepted as the complete cold-resume fix                                                                                 |
| `p3-persistence`, with both fixes     | BUILD PASS on `linux/arm64`; key `6e3bdd2927d87e250435fb39ca0ce836d5423c54c845033f647a2d6a54327caa`; CL image `sha256:69a1bca182ec60e2e995feac613205dc473be9a3bb240656bcb43bf11f530d4e` |
| BN/VC restart on `p3-persistence`     | PASS at cuts 3, 31, 32, 127 and 128, including comparison through slot 226 / finalized epoch 5                                                                                          |
| EL/BN/VC restart on `p3-persistence`  | PASS at the same five cuts, through slot 226 / finalized epoch 5                                                                                                                        |
| Complete `p3-persistence` Gloas suite | **11 passed, 0 failed**, 13 min 37 s, in one complete run                                                                                                                               |

Native targets ran in the builder before binary packaging. With both fixes, block 33 included the
same slot-32 attestation and state root
`0x5dd77bc7c7c50da1b95b0f19a0513a9b1d1a62e68cc486206f7463653f943672` as the uninterrupted network.

The complete command was `deno task test:profile gloas --bake p3-persistence`. It covered baseline,
lifecycle, e2e, two honest 1000-slot jumps, two fast 8192-slot jumps, economics, protocol,
withdrawal, deploy, Gloas barriers and extended cold restart.
[Verification](../reports/profiles/gloas/p3-persistence/verification.json) binds the bake key, suite
fingerprint and run ID `17a945d2-d5d4-4fc1-97fa-cbe928a23596`.

An earlier complete attempt had 10 passes and one failure because the exact Geth image disappeared
before the fast scenario. Its deletion source was not established for that attempt. After restoring
the same image ID from a local archive, the fast scenario passed individually and a new complete
suite passed. The final PASS belongs to that second whole run, not merged results from separate
attempts.

## What the real restart regression checks

The [cold-restart regression](../bakes/gloas/tests/restart.ts) is part of Gloas `test:profile`. It
compares BN/VC and EL/BN/VC restart with an independently created uninterrupted network at slots 3,
31, 32, 127 and 128. It compares complete signed blocks before and after restart, followed by a
transaction, subsequent blocks, rewards, finality and signing history.

Signing-history checks account for the pinned Lighthouse's actual pruning: records from the
current/previous epoch and each validator's highest record are retained, even when that highest
record is older. Every remaining record and signing root must survive restart unchanged. Checks also
cover watermarks, double/surround votes and resumed attesting. Required records cannot be removed or
signatures changed. Original exports remain in private test data.

The test additionally verifies complete sync/PTC participation, absence of attestation penalties,
and agreement on the finalized execution hash. Keys and databases are preserved; VC starts without
`--init-slashing-protection`.

In these direct-client tests, Docker reallocates private host ports when clients are recreated, as
in fast VC restart. Ports are transport resources, not persisted network state. Stable public
endpoints are provided separately by the later managed frontends.

## Reliability and scope

The fix addresses the cause: missing messages become part of normal operation-pool persistence.
Evidence comes from production serialization/storage with real signatures and a separate real-client
comparison against an uninterrupted reference network. Exact next-block equality checks behavior
that RPC availability or head movement cannot establish.

These tests establish clean stop after a completed slot and restart on the same data, including
epoch boundaries, on `linux/arm64`. AMD64 CI and publication were not performed in this run.
Previously published images do not acquire the fix automatically; release requires a new bake.

At this historical stage, completing P2/P3 still required admission and writer draining, explicit
checkpoint ACK after every component was saved, completeness checks for pending buffers, parked
startup, refusal of missing/corrupt databases and controller lifecycle recovery. Those requirements
are now covered by the separate current report. The original upstream shutdown merely logged some
persistence errors, so exit code 0 was insufficient evidence of a checkpoint. This persistence fix
alone does not make SIGKILL or copying live volumes a reliable snapshot mechanism.
