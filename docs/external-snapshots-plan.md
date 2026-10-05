# External snapshots

Extension to the completed [local snapshot plan](snapshots-plan.md).

## Contract

Export a saved Panda snapshot as one `.panda-snapshot.gz` file. Start an independent network with
`Devnet.fromSnapshot(pathOrHttpsUrl, { id, sha256? })` or
`deno run -A src/cli.ts snapshot open <path-or-https-url>`. Existing snapshot IDs keep their current
behavior. The container accepts `PANDA_SNAPSHOT` and optional `PANDA_SNAPSHOT_SHA256` on first
startup; an existing active generation takes precedence on subsequent starts.

The archive carries the complete stopped EL/BN databases, validator keys and signing history,
admission ledger, native checkpoint, configuration and immutable client identities. Import checks
the exact bake key, image IDs, platform and checkpoint ABI against a locally installed bake. A local
tag alias may be selected with `bake` / `--bake`; imports never build clients. Imported data belongs
to the destination owner, with local filesystem ownership. It cannot replace active data.

Use public HTTPS download URLs, including GitHub Release assets (HTTPS redirects supported), or
local regular files. Private repository authentication and arbitrary Ethereum database dumps are
outside this extension. SHA-256 pins the downloaded file; it does not establish who published it.
Only use trusted fixtures: the archive contains executable-client database input and test keys.

## Format and failure safety

A versioned gzip stream contains a bounded JSON header followed by sorted file bytes. The header
records relative paths, modes, lengths and SHA-256 hashes. No archive extraction command or
dependency is needed. Reject traversal, links, special files, duplicate/invalid layouts, corrupt or
truncated data, trailing bytes, incompatible clients, insecure redirects and oversized inputs.
Default transfer/unpacked limit: 8 GiB each, configurable in the SDK. Header limit: 16 MiB.

Export runs through the controller HTTP API, so an SDK client does not read the controller's private
directory. Files are streamed with bounded memory. Import validates an inactive temporary tree and
publishes a local immutable snapshot atomically before the existing restore pipeline starts clients.
Failures leave active state untouched and remove temporary files. Process-loss leftovers remain
hidden `.pending-*` work and cannot be listed or restored. The destination must have no active
generation; importing a fixture is never an implicit reset.

## Implementation and acceptance

- [x] E1: failing behavior regression for the archive HTTP API; safe streaming codec and storage
      export/import, including corruption, path, compatibility, limits and cancellation tests.
- [x] E2: SDK, CLI and container first-start integration; document reproducible file and GitHub
      examples, checksums, compatibility and existing-volume precedence.
- [x] E3: real Gloas file and HTTPS startup with a different owner; independently compare saved
      chain/storage/SSZ/receipt state, then execute another transaction and resume finality. Verify
      source immutability, refused invalid input and cleanup. Test packaged first-start and restart.
- [x] E4: static/unit and relevant existing snapshot regression checks, final review and recorded
      evidence. No native client rebuild is required.

Status: **E1–E4 and the PTC reliability follow-up are complete locally on October 4, 2026**,
Gloas/Linux ARM64. The initial extension used the existing clients; the follow-up below requires
Lighthouse baker 4. No artifacts were published.

## Executed acceptance

| Check                                                                   | Result                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `deno task check` and `git diff --check`                                | PASS                                                                                                                 |
| `deno task test`                                                        | 318 passed, 144 steps; 24 opt-in checks ignored, 75 s                                                                |
| Final `tests/snapshots_test.ts`, including two subsequently added cases | 20 passed, 32 steps, 9 s                                                                                             |
| Final `tests/cli_snapshot_test.ts`                                      | 2 passed; includes CLI HTTP download to the caller's file                                                            |
| Selected real Gloas profile: `resume`, `snapshots`, `snapshot-external` | 3/3 PASS, 5 min 22 s; 17 other scenarios filtered out                                                                |
| Complete new local/HTTPS scenario                                       | PASS, 79.7 s; both copies resume slot 3, include the next transaction and finalize epoch 2 at slot 128               |
| `test:image panda-ci-gloas:external.1 gloas`                            | PASS, 162.6 s; new volume starts at slot 195, transaction reaches 196, restart retains 196 with an invalid seed file |
| Scoped Docker resource audit                                            | 18 test owners, zero remaining containers, networks or volumes                                                       |

The real scenario checks independent contract storage, receipt, complete Beacon SSZ bytes, signing
history, PTC votes, EL/CL finality agreement and source immutability. HTTPS uses a local CA and a
separate server certificate with normal TLS verification and a redirect to an asset. No file was
uploaded to GitHub; public Release assets use the same direct HTTPS transport. Source and
destination are distinct owners. The exported acceptance fixture was 524,301 bytes.

Acceptance identity:

- Bake `gloas/p3-checkpoint-r5`, key
  `24026a9da94b51171f1d67f810de97add9a15d4b06891ee6e2ceed5457248a53`, checkpoint ABI 1.
- Initial extension suite fingerprint:
  `9366b59b01606e5ab0748abff5a6abc560e86dd4d11999b41f016e2ab5ef5791`.
- Three selected report run IDs: `external-snapshots-final`. See
  [external snapshot report](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-external.json),
  [resume](../reports/profiles/gloas/p3-checkpoint-r5/resume.json) and
  [snapshots](../reports/profiles/gloas/p3-checkpoint-r5/snapshots.json).
- Local wrapper image: `sha256:dcfad6dd3ebef39722976f9fab3ac4a9301282dfba5985a310f4412f9f050844`;
  all 41 packaged runtime files match the working tree. EL/CL/genesis identities remain those of the
  selected bake. The container seed archive was 1,456,519 bytes.

Initial extension acceptance covered the selected scenarios above. The complete 20-scenario
verification was subsequently performed for the PTC repair below. Linux AMD64 and public publication
remain separate release work. Private command logs and failed-run data remain under ignored
`.cache/external-snapshots/` and `.panda/`.

## Review findings and follow-up

Completed repair: reproduce controlled VC startup with delayed validator-index and PTC HTTP
responses, then require completed discovery and current/next-epoch PTC loading before starting duty
services. Independent reviews found no existing Panda/client API that can initialize the VC's
private cache. The client changes are limited to startup ordering/error propagation and two existing
PTC timer adaptations backed by Panda's clock helper. Signing, publication, slot selection, retry
policy, cache invalidation and BN validation remain unchanged. Controller-side delays cannot prove
when a native timer has been registered; that conversion must retain the selected slot's absolute
deadline. Native acceptance, the final bake, the separate real-network reproduction and the complete
profile passed. The original incident's exact scheduling was not recorded.

- [x] Deterministic startup regression: delayed index discovery, delayed PTC responses, HTTP
      failures and a legitimately unregistered validator (404).
- [x] Minimal startup fix and independent review of the actual source diff.
- [x] Two deterministic clock-interleaving regressions and absolute PTC deadlines; nonzero clock
      origin, elapsed deadline and parked-clock checks.
- [x] Re-run source continuation and local/HTTPS import, checking all 512 PTC positions both in the
      first block and in the next block containing freshly produced votes.
- [x] Build immutable Gloas bake `ptc-reliability-r7` (Lighthouse baker 4, checkpoint ABI 1).
- [x] Full selected profile and recorded results.

Repair evidence: exact r5 failed all four native cases on their behavioral assertions (11.58 s). The
same assertions passed after the bootstrap change (4/4, 10.19 s); only the test's call adapter
changed for the new async entry point. `cargo check --release --locked -p validator_client` passed.
Final Panda unit tests passed 320 cases/144 steps, with 24 opt-in checks ignored. Independent
reviews confirmed the production scope: startup ordering in two VC files, two existing PTC waits in
a third file, and a six-line Panda clock helper. Signing, PTC cache and BN source are unchanged.
Maintainer generation matched the tested production source, and the patch applied to the exact
pinned commit. Raw logs remain under ignored `.cache/ptc-bootstrap/`.

The final bake passed every native target, including all 79 `panda_ptc` tests. Geth was reused from
cache. The original real scenario then passed separately in 77.332 s (`ptc-r7-original`): source
continuation was immediate after snapshot creation; both local and HTTPS copies resumed slot 3 and
finalized epoch 2 at slot 128, with full PTC participation in their first two new blocks. Bake key:
`6c4a05573eb71bf8a3c2298cc015ac71508c3f6451b235108c0b7517fe4f7908`, Linux ARM64.

Full acceptance: `PANDA_TIMEOUT_MS=300000 deno task test:profile gloas --bake ptc-reliability-r7`
passed **20/20 scenarios in 34 min 24 s**, in one uninterrupted run. This includes ordinary clients,
both warp modes, economics, deposits/consolidation/withdrawal, cold restart, checkpoint/resume, blob
data, snapshot crash recovery and external fixtures. Final readback matched all 20 report run IDs,
the current suite fingerprint and all 24 native input hashes. The separate reproduction and full run
left zero containers, networks or volumes for their 31 recorded owners.

- [Verification and scenario reports](../reports/profiles/gloas/ptc-reliability-r7/verification.json).
- Run ID: `1c2a6833-b068-4a07-bf11-db1f26078a7e`.
- Suite fingerprint: `5b27b56ec62d4c8890dd4058f6aef5019e8dc683cb6db2e55031d122ad8ac5ef`.
- CL image: `sha256:dceee0d97ef9b5a3da164310804e471a166a8b07167b92b96b7b24d356b353f4`.

Both independent reviews found no outstanding issue in these two fixes. This does not claim a
general rewrite or repair of upstream PTC behavior, such as discovering newly imported keys after
startup. Existing published images and the default bake are unchanged; release baker 4 to deliver
the fixes to image consumers.

Why the earlier checks missed this: persistence tests began with verified PTC messages already in
the BN pool. Real restart tests compared blocks at several cuts, but did not hold index discovery
open while VC startup ran. Neither checked that initial PTC loading finished before readiness. The
new regression controls those HTTP responses and checks that exact prerequisite.

A separate clock-adapter race was confirmed during review: converting a previously calculated
relative duration using a later clock reading can move a PTC deadline past the controller's current
phase. It can also affect the existing retry after an early HTTP failure. This is not evidence of
the original incident's scheduling. Both regression assertions failed with relative waits (11.44 s)
and passed with the absolute-time adapter (1.32 s). The shared clock test with a nonzero origin,
elapsed deadline and park passed, as did `cargo check`. The ordinary-clock branches are unchanged.

- **Fixed:** old resume comparisons depended on JSON key ordering. Portable canonical JSON exposed
  false configuration and file-inventory mismatches. Canonical comparisons preserve every field and
  byte hash; the regression accepts reordered keys and rejects tampered validator data before any
  client starts. Real import subsequently passed.
- **Fixed:** invalid transfer options could leave an input stream unclosed. Cleanup now runs for
  validation failures as well as canceled/failed copies. Separate red/green evidence was retained.
- **Verified:** active-owner refusal before download and a second check under the network lock;
  exact bake/image/platform matching; local numeric ownership; immutable content-addressed imports;
  no-clobber export; bounded streaming; duplicate JSON/path/link/length/corruption rejection;
  canceled-download cleanup; SDK access through HTTP; container seed precedence on restart.
- [x] **PTC reliability follow-up:** one exploratory source-continuation run produced slot 4 but
      waited at phase 9,000 ms for the VC `payload_attestations` completion mark. This happened
      after source snapshot creation and before import. The run was stopped once, its logs retained,
      and only its exact owner's Docker resources removed. Subsequent passing runs alone did not
      close the issue. The repair above instead adds failing regressions for two confirmed races,
      fixes those races, and repeats immediate source continuation and import with full PTC checks.
      Their exact interleaving in the original incident cannot be reconstructed from its logs.
