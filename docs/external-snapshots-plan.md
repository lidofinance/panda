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

Status: **E1–E4 complete locally on October 4, 2026**, Gloas/Linux ARM64. The runtime reliability
observation below remains open; passing checks do not explain that incident. No native clients were
rebuilt and no artifacts published.

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
- Current suite fingerprint: `9366b59b01606e5ab0748abff5a6abc560e86dd4d11999b41f016e2ab5ef5791`.
- Three selected report run IDs: `external-snapshots-final`. See
  [external snapshot report](../reports/profiles/gloas/p3-checkpoint-r5/snapshot-external.json),
  [resume](../reports/profiles/gloas/p3-checkpoint-r5/resume.json) and
  [snapshots](../reports/profiles/gloas/p3-checkpoint-r5/snapshots.json).
- Local wrapper image: `sha256:dcfad6dd3ebef39722976f9fab3ac4a9301282dfba5985a310f4412f9f050844`;
  all 41 packaged runtime files match the working tree. EL/CL/genesis identities remain those of the
  selected bake. The container seed archive was 1,456,519 bytes.

The full 20-scenario profile, Linux AMD64 and public publication were not rerun or performed for
this extension. The previous full 19-scenario result is historical prerequisite evidence, not a
current whole-profile verification. Private command logs and failed-run data remain under ignored
`.cache/external-snapshots/` and `.panda/`.

## Review findings and follow-up

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
- [ ] **Open runtime observation:** one exploratory source-continuation run produced slot 4 but
      waited at phase 9,000 ms for the VC `payload_attestations` completion mark. This happened
      after source snapshot creation and before import. The run was stopped once, its logs retained,
      and only its exact owner's Docker resources removed. The same exported file then passed import
      and finality. The final three-scenario run and packaged tests did not reproduce the stall.
      Root cause is unconfirmed; this extension does not claim to fix it or establish that it was
      caused by the transport. Failure before import does not rule out a problem in snapshot
      capture or source stop/resume; later passing runs do not close this reliability issue.
