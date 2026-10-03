# Bake profiles and client versions

Profiles are named after hardforks: `pectra` or `gloas`. Each profile can contain multiple builds
with arbitrary tags. For example, `gloas:default` and `gloas:experiment-2` use the same protocol but
may contain different EL/CL versions.

| Profile  | EL / CL           | Controller behavior                                                    |
| -------- | ----------------- | ---------------------------------------------------------------------- |
| `pectra` | Prague / Electra  | Engine FCU V3, get/newPayload V4; payload inside BeaconBlock           |
| `gloas`  | Amsterdam / Gloas | Engine FCU V4, getPayload V6, newPayload V5; separate envelope and PTC |

Both profiles use the mainnet preset: 12-second slots and 32-slot epochs. Gloas refers to the pinned
experimental implementation in `bakes/gloas/recipe.json`. Compatibility with another upstream commit
requires verification with the test suite.

Current development and CI focus on Gloas. Pectra is temporarily paused in `src/active_profiles.ts`;
its recipes and historical artifacts remain readable. Explicit local Pectra runs are still possible,
but release workflows reject the paused profile. Both `bake` and its `build:clients` alias default
to Gloas when no hardfork is specified; an explicit local profile takes precedence.

## Hardfork layout

Recipes, patches, profile-specific Rust sources and additional tests live in `bakes/<hardfork>/`.
Shared clocks and scenarios live in `bakes/shared/`; built manifests live in `<hardfork>/tags/`. One
builder composes shared components using the profile's declarative strategy.

See the [layout and extension guide](../bakes/README.md). The earlier directory relocation preserved
existing patches, Rust helpers and nine manifests byte for byte. Its checks and limitations are
recorded in the [relocation report](bake-layout-verification.md).

## Build, verify and start

```sh
deno task bake gloas --replace
deno task bake gloas --tag experiment-2

deno task test:profile gloas
deno task test:profile gloas --bake experiment-2

deno task bakes
deno task up --profile gloas --bake experiment-2
```

`up` consumes a built manifest without compiling clients. A missing bake produces an error with the
build command. A running instance with a different profile or tag is rejected. Use different
`PANDA_ID` and `PANDA_PORT` values for simultaneous networks.

CL and EL compiler containers use at most four CPUs, capped by the Docker daemon's reported CPU
count. A two-CPU CI runner therefore gets a two-CPU container limit. Cargo's two concurrent build
jobs are a separate setting; they do not determine the Docker CPU limit.

On a new machine, `--replace` builds local artifacts from the pinned recipe: committed manifests may
refer to images from another host, and Git does not transfer `.cache/`. For an existing local tag,
`deno task bake gloas` reuses its pinned artifacts.

```ts
import { Devnet } from "../src/api.ts";

await using net = await Devnet.start({ id: "contracts", profile: "gloas", bake: "experiment-2" });
await net.advanceTime(3600);
await net.advanceTo(new Date("2033-06-01T00:00:00Z")); // Must be later than current protocol time.
await net.setAutomine(true);
```

`PANDA_PROFILE` and `PANDA_BAKE` select the same settings through the environment, including for
individual `e2e:*` tasks. Explicit API/CLI options take precedence. The runtime default is
`gloas:default`. The validator lifecycle commands `test:protocol`, `e2e:protocol` and
`e2e:withdrawal` instead cover all active hardfork profiles (currently Gloas only) when
`PANDA_PROFILE` is unset, using the selected bake tag for each. See the
[readable protocol suites](../bakes/shared/tests/README.md) for their steps and selection.
`build:clients` is an alias for `bake`.

## Other EL and CL versions

```sh
# A compatible Lighthouse ref and clock patch; the profile remains gloas.
deno task bake gloas --tag candidate --cl-ref <commit-or-ref> --patch bakes/gloas/my-clock.patch

# A prebuilt EL image or an unmodified Geth source build.
deno task bake gloas --tag el-image --el-image <image-tag-or-digest>
deno task bake gloas --tag el-source --el-ref <commit-or-ref>

# A compatible genesis generator when needed.
deno task bake gloas --tag genesis-candidate --genesis-image <image-tag-or-digest>
```

EL and genesis default to the recipe's pinned images. CL is built from its pinned commit with the
profile patch and shared clock source. The builder runs the native Rust clock test before compiling
Lighthouse. Git refs resolve to commits; Docker refs resolve to image IDs/digests and platforms. If
a mutable Docker tag already exists locally, the builder pins that local image. Use a digest to
select an unambiguous version.

Patches apply strictly: an incompatible ref fails the build. Adding a hardfork requires its own
recipe, schedule/Engine/Beacon API support and scenario list. A new tag alone does not change
protocol rules.

`--import-cl <image>` imports an existing controlled-clock image. This pins its ID but does not
prove that the binary was built from the declared source or passed native tests. The import is
recorded in `source.importedCl`; run `test:profile` afterward. The imported binary must match the
recipe's clock environment and protocol. Current recipes use `PANDA_CLOCK_START_MS` and
`PANDA_CLOCK_PORT`.

## Manifests, caches and tag replacement

- Recipes: `bakes/<hardfork>/recipe.json`.
- Built manifests: `bakes/<hardfork>/tags/<tag>.json`, including the recipe, source commits,
  patch/clock hashes, image IDs, digests, platform and builder images.
- Sources, patched trees and artifact caches: ignored `.cache/baker/`.
- Exact local image archives: `.cache/baker/images/<image-id>.tar.gz`. If an image is removed from
  Docker, the builder restores it from the archive and verifies the same image ID. Registry images
  are restored through their pinned digest.
- Cargo/Go caches: Docker volumes with the exact `io.panda.id` ownership label.

Repeating `bake` for an existing tag reuses its pinned images. To change it, use `--replace` or
choose another tag. A new manifest is published atomically after a successful build; failure
preserves the previous manifest. Locks protect tags and shared compiler caches against concurrent
writes. Identical inputs under another tag reuse the built artifact. A running network keeps its own
copy of the bake manifest.

The local `bake` command does not publish images. A manifest alone cannot transfer binaries to
another machine. Use a separate build tag for another architecture; image identity and platform
mismatches are rejected.

The separate **Publish Lighthouse images** workflow publishes amd64 clients after their native Rust
tests and emits a `clients.lock.json` containing the original bake plus registry transport identity.
It opens a release PR containing `bakes/<hardfork>/release/clients.lock.json` and the planned Panda
Git tag. Merging that PR creates the tag and triggers Panda's full profile and packaged-service
checks before Panda publication. A failing Panda check leaves the published Lighthouse image
available for reuse. `clients:pin` remains available for manual recovery.
`deno task clients:restore <hardfork>` restores that exact bake by registry digest and verifies
image IDs; it never compiles or substitutes clients. Panda Git releases (`vX.Y.Z`) use independently
versioned Lighthouse images (`v<upstream>-<commit>-b<bakerVersion>-<hash>`). See the
[CI publication guide](ci-containers.md) for the full sequence.

## Test suites

`bakes/<hardfork>/recipe.json` explicitly maps scenario names to executable files. `test:profile`
runs only the selected profile and tag's integration scenarios. `test` runs shared unit tests;
`test:baker` separately checks Docker rollback/ownership and the builder. Changing one bake does not
build or test the others.

| Scenario                                                                                     | Pectra | Gloas |
| -------------------------------------------------------------------------------------------- | ------ | ----- |
| Ordinary upstream clients: first block and EL/CL agreement                                   | Yes    | Yes   |
| CLI up/down/reset, stable genesis, rejection of a different profile                          | Yes    | Yes   |
| Pause, advanceTime/advanceTo, future timestamps, automine, nonce gaps, finality, indexer     | Yes    | Yes   |
| Two honest 1000-slot / fast 8192-slot jumps: next transaction, finality and signing history  | Yes    | Yes   |
| Honest warp: participation, attestation rewards, sync/PTC coverage, finality and next deploy | Yes    | Yes   |
| Deposit, key activation and consolidation                                                    | Yes    | Yes   |
| Signed voluntary exit, actual withdrawal and final zero balance                              | Yes    | Yes   |
| Twenty sequential deployments through raw RPC and ethers                                     | Yes    | Yes   |
| Separate envelope, matching bid/hash, PTC votes and phase barriers                           | —      | Yes   |

The consolidation scenario explicitly uses `churnLimitQuotient: 4` to give the small network
consolidation capacity. Gloas also sets the independent `consolidationChurnLimitQuotient: 4`:
changing general churn no longer increases consolidation capacity in this fork. The separate
quotient defaults to the mainnet value of `65536`; other scenarios retain their profile's mainnet
churn. Long exit/consolidation periods use explicit `skipSlots` and incur real protocol penalties.

Reports are stored in `reports/profiles/<hardfork>/<tag>/`. The final `verification.json` records
the bake key, unique run ID, test/controller/dependency fingerprint and current results. Reports
from another run or bake do not count. Changing code during verification fails the result. `bakes`
shows `verified: true` only when the bake key and current fingerprint match; `verifiedAt` retains
the date of a historically successful run. The fingerprint includes only the selected profile's
scenarios and runtime dependencies. Another profile's changes, future recipes or patch edits do not
invalidate verification of an unchanged baked artifact. Shared runtime changes require affected
profiles to be verified again, without necessarily rebuilding their clients.

Gloas finality is checked through the execution parent of the finalized Beacon checkpoint: that
checkpoint's own envelope is not yet the finalized payload. This follows the
[pinned Lighthouse implementation](https://github.com/sigp/lighthouse/blob/2d281dfa1b407f7c81cd123954a9fd18ee8f02d2/consensus/proto_array/src/proto_array_fork_choice.rs#L363).

Use `--rust-image` and `--go-image` for another toolchain. `--baseline-image` selects an ordinary
Lighthouse for checks without controlled clocks. To run a particular bake's native regression:
`deno task test:clock gloas --bake experiment-2`. It uses that bake's archived inputs in
`.cache/baker/inputs/<key>/` and verifies their hashes. Editing a patch for a new build does not
prevent testing an older artifact. For manifests without a source archive, recovery requires an
exact hash match from the working tree or Git; otherwise native verification is rejected.

Both warp modes use the same immutable client bake. Default `advanceTime`/`advanceTo` preserve
continuous duties; `{ mode: "fast" }` explicitly skips gaps and accepts their ordinary penalties.
The selected Gloas honest implementation remains `direct-sync`, key `e41c863b…`; isolated group
signer research is not installed. Mode selection changes only the controller/API. Pectra is checked
independently with its selected artifact; Gloas timings do not describe Pectra.

Each profile routes `warp` to the long honest scenario, `warp-fast` to the fast scenario, and
`warp-economics` to short continuous-participation checks. Fast has a 25-second budget including the
next transaction; honest has a separate long watchdog and economic gates. Scenario coverage is not a
passing profile verification. See [mode validation](warp-modes.md) and
[historical TDD evidence](warp-tdd-results.md).

The Gloas patch reuses candidate balances and sixteen random values per SHA-256 digest; small
validator sets use upstream batch shuffling. Native tests compare PTC and proposer selection with
the original algorithm. Before resuming the VC, the BN processes real empty slots once and retains
the resulting states for duties, proposals and block validation. Preparation does not substitute the
canonical head or finalized checkpoint. Bakes with `preparedSkip` use ordinary bounded waits in
place of the earlier 10–12 minute catch-up. Runs concurrent with compilation are not performance
measurements.

## Stable time advancement

This section records stabilization on September 29, 2026. Reruns after the September 30 directory
relocation are recorded in a [separate report](bake-layout-verification.md).

The selected `gloas/stable` uses the same immutable image as `fast-warp-v3`, with ordinary
`store.put_state` calls for every intermediate state. Batched summary writes from v4 and a separate
equal-balance branch from v5 were excluded. Further optimization was paused at the user's request to
keep the client change smaller. Controlled mode uses Lighthouse's standard
`--hierarchy-exponents=9,13,16,18,21`; protocol constants are unchanged.

That full suite passed 8/8 scenarios with `verified: true`. Its two 8192-slot jumps including the
following transaction took 10.8 / 11.6 seconds. Both resumed finality; all 64 validators continued
signing without slashing or conflicts. At that stage the regression threshold was 25 seconds to
account for VC startup variation; the earlier 10-second target is no longer an acceptance criterion.
The report is `reports/profiles/gloas/stable/verification.json`.

On September 30, 2026, the user approved raising the shared threshold from 20 to 25 seconds. This
changed the test criterion while retaining the advancement algorithm and finality/signing-history
checks.

During direct-sync work, the assistant incorrectly treated 25 seconds as a nonblocking target and
introduced a 30-minute watchdog. The user rejected the resulting run and requires at most one
minute. That watchdog must be corrected before another large test; it is not an accepted performance
budget.

```sh
deno task up --profile gloas --bake stable
deno task test:profile gloas --bake stable
```

## Lighthouse upstream and baker identity

Each current recipe declares `clVersion` and `bakerVersion` alongside the pinned `clRef`. The native
builder checks `clVersion` against the source's Cargo package version. For an explicit `--cl-ref`
override, it records the version actually found in that source. Old immutable manifests remain
readable and are not rewritten.

A native bake records `lighthouse.upstream` (version, full commit and repository),
`lighthouse.baker` (version and input hash), platform and its own client build key. The baker hash
covers the builder implementation/dependencies, selected patch, clock, native sources/tests and
pinned build/runtime images. An explicit baker-version bump or changed baker inputs produces a new
image identity. Panda controller changes and other profiles' native patches do not.

The separate `.cache/baker/lighthouse/<key>.json` cache lets a new EL/genesis selection reuse an
unchanged native Lighthouse image. Full bake identity still includes the entire selected recipe and
all client identities. Existing local tags remain immutable; select a new tag for a new combination.

CI derives a client image tag from upstream and baker versions. If that image already exists, it
passes its immutable digest to `bake --reuse-cl <digest>`. The builder verifies the complete
identity embedded in the image before accepting it, preserving native build provenance. This differs
from `--import-cl`, which makes no claim that an arbitrary image was built and tested by this baker.
The profile suite runs against the selected combination before publishing a new client lock.
