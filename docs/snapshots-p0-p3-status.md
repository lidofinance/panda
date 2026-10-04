# P0–P3 verification and audit

Recorded on 2026-10-04. **P0–P3 are accepted locally for Gloas on Linux ARM64: the complete profile
passed 13 scenarios with 0 failures in 911.669 s (15 min 11 s).** P0–P1 established the baseline and
reproduced the persistence defect. P2 implements lifecycle, storage and admission; P3 implements
verified clean checkpoint and resume. Pectra is deferred. Reusable snapshot archives and hardfork
transitions remain separate, unimplemented P4+ stages in the [plan](snapshots-hardforks-plan.md).

For usage, see [lifecycle and persistent storage](lifecycle.md). Historical evidence is recorded in
[P0–P1](snapshots-p0-p1.md) and the [initial persistence fix](snapshots-p3-persistence.md).

## Verified build

- Bake: [`gloas/p3-checkpoint-r5`](../bakes/gloas/tags/p3-checkpoint-r5.json), `linux/arm64`.
- Bake key: `24026a9da94b51171f1d67f810de97add9a15d4b06891ee6e2ceed5457248a53`.
- Lighthouse 8.2.2, commit `2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`, baker 3, checkpoint ABI 1.
- Geth: clean source commit `5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186`. The r5 build reused the
  verified independent EL cache: its build trace contains one CL compiler and no Go compiler.
- Packaged service: `panda-ci-gloas:p3-r5.1`, image ID
  `sha256:a3ea69cdc7f7412e9d1103cc16b391e752afce7934143075a543e0d188eef0fd`. All 41 packaged
  runtime, container and dependency source hashes match the tested working tree.

## Executed checks

| Check                                          | Recorded result                                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno task check`                              | PASS                                                                                                                                                        |
| `deno task test`                               | 240 tests + 75 steps PASS, 0 FAIL, 17 intentionally excluded Docker/devnet tests; 24 s                                                                      |
| Independent startup/HTTP/Engine regression run | 36 tests PASS, 2 s; real localhost requests, no Docker                                                                                                      |
| Native r5 build tests                          | All targets PASS: clock, BLS, weighted selection, direct sync, 14 checkpoint cases, HTTP/signing/migrator cancellation and real KZG reconstruction          |
| Native source binding                          | PASS: 20 input hashes, archived inputs, builder identity, bake key, 63 patched paths and the injected clock source/tests                                    |
| `deno task smoke:docker`                       | PASS, 3.932 s                                                                                                                                               |
| `deno task test:baker`                         | 4 PASS, 0 FAIL, 41 s; reuse/archive restore, EL startup rollback and preservation of another owner's resources                                              |
| Standalone managed resume                      | PASS, 194.500 s; guards, admission, cuts 3/31/32/127/128, independent reference, next transaction, finality and signing history                             |
| Economics after the HTTP fix                   | PASS; missing duty produced the expected server failure in 30.083 s, with the original assertions preserved                                                 |
| Packaged service                               | PASS, 80.298 s; interrupted startup exited in 1.765 s, followed by restart using the same container, ports and volume, checkpoint, transaction and finality |
| Final complete Gloas profile                   | **13 PASS / 0 FAIL, 911.669 s**                                                                                                                             |

The final profile command was `deno task test:profile gloas --bake p3-checkpoint-r5`.
[Verification](../reports/profiles/gloas/p3-checkpoint-r5/verification.json) records run
`a6c28953-f8eb-428a-891b-088ed9d5335f` and suite fingerprint
`90ebf7455ea68a15e025fb737d2ee9b0a0c7eb002ed8d746f9bcd09a9902a1f6`.

All 13 reports belong to that run and bake: baseline, lifecycle, e2e, honest warp (two 1000-slot
jumps), fast warp (two 8192-slot jumps), economics, protocol, withdrawal, deploy, Gloas, direct
restart, managed resume and blob checkpoint. The final result comes from one complete standard run;
it does not combine earlier standalone passes. The protocol scenarios include deposits, activation
and consolidation; the withdrawal scenario includes voluntary exit and complete withdrawal.

Before the full run, the three scenarios interrupted by the earlier environment failure passed
individually: withdrawal in 44.516 s, direct restart in 165.878 s and blob checkpoint in 45.822 s.
The full run used Docker Engine 29.8.1 and the same client images without recompilation. The
packaged service result was obtained earlier on Engine 29.2.0; the unchanged artifact and all 41
source hashes were rechecked, but that packaged test was not rerun on 29.8.1.

Overlapping focused suites are not added together. Adapter tests do not establish real protocol
behavior, and fixture preparation or infrastructure failures are not counted as behavioral RED.

## Defects fixed and checked

| Defect                                                                                                  | Fix and verification                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTC messages and verified naive attestations were lost during persistence                               | Versioned storage preserves the required pools. Native tests use real BLS messages, production serialization/storage and the next aggregate; real restart tests compare against an uninterrupted network.                                                                                          |
| The checkpoint at cut 127 required obsolete sync votes                                                  | The guard checks current and future **protocol** slots. Native RED reproduced the pools' different retention rules; regressions cover stale/current/future votes and a lagging head. Real cut 127 passed on r4 and r5.                                                                             |
| A sticky reconstruction flag was mistaken for unfinished work                                           | Completion requires actual persisted block/envelope records. Real KZG reconstruction demonstrates the sticky flag; a missing envelope still causes refusal.                                                                                                                                        |
| A hot-store receipt did not prove that cold/blob data existed; changed files reached startup            | Native sentinels/readback and a complete stopped inventory cover EL/BN data, keys and slashing protection. Hashing streams large files. Real missing/corrupt data injections fail before any client is created.                                                                                    |
| A native guard was released when the HTTP future was cancelled while work continued                     | Guards belong to the actual blocking, async, Rayon, queued, reprocessing and migrator tasks. Cancellation regressions and the final native targets passed.                                                                                                                                         |
| Early recovery in the checkpoint router hid ordinary BN POST routes                                     | One common POST union/recovery preserves routing. A production-router RED returned 404 instead of 200; park/resume/duties and unknown POST regressions now pass.                                                                                                                                   |
| A stale PID lock could admit two owners; metadata errors leaked ownership                               | A stable inode and OS lock protect ownership, with release in `finally`. Deterministic races and real SIGKILL were checked; other owners' generations and snapshots remain untouched.                                                                                                              |
| Syncing the active-pointer file did not make parent directory entries durable                           | Directory entries are synced before publishing the pointer; a fault-injection regression covers ordering.                                                                                                                                                                                          |
| Drain finished before the second SSE cancellation; stalled request bodies survived timeout              | Every lease remains active until cancellation completes, and abort closes stalled uploads. Independent streams, uploads, imports, automine and shutdown races are covered.                                                                                                                         |
| SIGTERM during SDK save could start another save or close the server too early                          | Shutdown waits for the current lifecycle operation; concurrent shutdown calls share completion and preserve the original error. Both call orders have RED/GREEN evidence.                                                                                                                          |
| Lifecycle results were lost with an HTTP ACK; automine failure left readiness true                      | Durable operation results/errors are available through an independent lifecycle endpoint. Timeline failure closes ingress. Adapter regressions cover both cases.                                                                                                                                   |
| Proxies returned decoded gzip bodies with stale wire headers                                            | Encoding and length headers are removed only for decoded fetch responses; manually encoded bodies remain intact. Real gzip/SSE checks cover all frontends, followed by real admission tests.                                                                                                       |
| A proven pinned-Geth invalid-signature rejection remained ambiguous                                     | Narrow rejection classification handles raw/raw-sync responses. Unknown responses, lost ACKs and accepted/evicted transactions remain unresolved until canonical evidence settles them.                                                                                                            |
| Fixtures bypassed managed VC admission; some frontends accepted an unrelated Origin                     | Key import/delete use managed endpoints, with a shared Host/Origin guard. Adapter and real packaged tests passed.                                                                                                                                                                                  |
| Resume followed by fast warp carried parked startup and slashing initialization into the replacement VC | The replacement opens the existing slashing DB and starts duties. A dedicated regression and packaged resume-to-fast scenario passed.                                                                                                                                                              |
| Stop watchdogs missed Docker transport; logging errors skipped cleanup                                  | The watchdog covers lookup, inspect and stop; exit 137 is a failure. Phase, log, Engine and client cleanup failures are collected independently.                                                                                                                                                   |
| Removing a generation destroyed diagnostic logs                                                         | Owned `logs/<generation>` survives stop, startup failure and down. Path and ownership regressions cover retention.                                                                                                                                                                                 |
| SIGTERM after dockerd startup did not interrupt a stalled client startup                                | A real paused-genesis RED exited 137. Cooperative cancellation aborts read-only waits and waits for Docker mutations before cleanup, preventing late creates. The packaged repeat exited 1 in 1.765 s and then started fresh on the same volume.                                                   |
| Combining default and explicit HTTP signals cut a caller's 40 s budget to 30 s                          | The full-profile economics failure exposed the regression. Explicit signals regain precedence; the additional watchdog is restricted to startup probes. Localhost RED/GREEN checks cover explicit budgets, startup cancellation and per-request deadlines; the original economics scenario passed. |
| A startup signal could later close the working Engine log stream                                        | The child signal applies only through subscription handshake, after which the listener and watchdog are removed. Late abort/watchdog regressions passed; established streams close explicitly.                                                                                                     |
| A CL-only change to the common bake key recompiled Geth                                                 | An independent EL cache binds exact source, toolchain, runtime, platform and revision, with image ownership and provenance checks. Stale-lock and cross-source cache-splice regressions passed; normal r5 compiled one CL and no EL.                                                               |

The sync guard follows the upstream rule: a block at slot B after a completed cut C needs the sync
aggregate for B−1, where B−1 ≥ C. Votes older than C cannot contribute; current and future votes
still require persisted contributions. A separate lagging-head test verifies the use of protocol
slot rather than head slot.

## P2–P3 acceptance coverage

| Requirement                                                                                                  | Executed evidence                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New/open, preserve/destroy, ownership, layout/path safety and crash locks                                    | `storage_test.ts`, `generation_copy_test.ts`, `lifecycle_failure_audit_test.ts`, real guards and CLI lifecycle                                                                     |
| Inactive generation copy preserves content, modes, UID/GID and the active pointer                            | `generation_copy_test.ts` and real stopped EL/BN database copies in `checkpoint_guards.ts`                                                                                         |
| Missing/corrupt shared keys, slashing DB and EL/BN data are refused before startup                           | `database_inventory_test.ts`, `storage_test.ts` and actual injections with zero clients created                                                                                    |
| Save is isolated from advance, automine, imports and shutdown; no late mutation                              | `controller_races_test.ts`, ingress/frontend/lifecycle tests, native HTTP/VC cancellation and real service SIGTERM                                                                 |
| Ledger intent/result is durable before forwarding/ACK; duplicates, notifications and reconciliation are safe | `admission_test.ts`; real fee-capped transactions, lost caller/upstream ACKs, exactly-once forwarding, ambiguous-to-canonical confirmation and 80 accepted/16 evicted transactions |
| Owning/borrowed SDK close and CLI stop/resume/open/down/reset                                                | Adapter tests and real `bakes/shared/tests/lifecycle.ts`, including clean owner-process loss followed by open, and unclean-stop refusal                                            |
| Persistent packaged service with stable endpoints, health, authentication and logs                           | `scripts/test_image.ts`: same outer container/ports/volume, exact state, new session IDs, keys/token, next transaction, FFG/EL agreement and another restart after SDK stop        |
| Native ACK binds clock, roots, fork-choice slot, pools/PTC/custody and atomic write/readback                 | 14 native restart/checkpoint cases, `checkpoint_guards.ts` and real managed continuation                                                                                           |
| Pending/retained user operations preserve ordinary BLS/state transitions and once-only inclusion             | `native/restart_test.rs`; real deposit, activation, consolidation, exit and withdrawal scenarios                                                                                   |
| Pending envelopes/DA are refused; complete blob data survives cold resume                                    | Native pending/missing checks and `blob_checkpoint.ts`: real nonzero Geth KZG, equality of 128 columns and the envelope, cold resume, PTC/transaction/FFG/reference                |
| Partial data-column reconstruction                                                                           | `native/reconstruction_test.rs`: corrupt cell rejection, 63 insufficient columns, real KZG recovery from 64 to 128 columns, sticky flag and missing-envelope refusal               |
| Clean VC→BN→EL shutdown and parked startup without a new genesis                                             | Native/adapter watchdog tests, direct restart, managed resume and packaged service                                                                                                 |
| An uninterrupted independent network provides the reference                                                  | Direct CL-only/all-client and managed cuts 3/31/32/127/128; next blocks, economics/participation, transactions, finality and signing history                                       |

## Build binding and review

Independent review recomputed native input hashes, Lighthouse builder identity and the full bake key
including `executionBuild`, checked archived sources and exact image IDs/platform, and compared the
maintained patch with the compiled checkout. Upstream HEAD and reverse application were checked
separately. Storage/copy/inventory changes were also reviewed independently from their author.

The EL reuse proof binds the same source, toolchain, runtime and revision. Readback of two local
image archives verified OCI configuration/layer digests: reused r2 and prior r3 contain the same
80,658,432-byte Geth binary, SHA-256
`93744238254e766fbc7e8d205ca8f10300ed64dde3949878421e23e0a5a664d2`. This establishes binary
equality, not equality of the complete images. All 41 packaged source hashes were also checked.

## Historical failures and limits

Earlier runs remain failures: r3 had 9 PASS / 3 FAIL; the first r5 had 12 PASS / 1 FAIL from the
subsequently fixed explicit HTTP deadline; the next r5 had 10 PASS / 3 FAIL after client images were
removed by the host environment. After the environment was corrected, the three affected scenarios
and then a new complete run passed using the same client images. Counts, run identities and
resolutions remain in the [machine-readable status](../reports/snapshots/p0-p3-status.json);
original private evidence is retained under ignored `.cache/`.

Acceptance covers clean managed stop and resume on local Linux ARM64. Incomplete or corrupt
generations are refused rather than replaced by a fresh genesis. Arbitrary database corruption
recovery, AMD64/CI, image publication, Pectra, reusable snapshot archives and hardfork transitions
are outside this result.

The KZG component exercises real cryptographic reconstruction through the BeaconChain path used by
the processor. It does not establish end-to-end delivery of partial columns from external peers.
Complete blob cold resume has separate real Geth/Lighthouse coverage.

Canonical evidence:
[full-profile verification](../reports/profiles/gloas/p3-checkpoint-r5/verification.json),
[managed resume](../reports/profiles/gloas/p3-checkpoint-r5/resume.json),
[packaged service](../reports/snapshots/p0-p3-packaged-r5.json).
