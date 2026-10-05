---
name: maintain-bakes
description: Maintain Panda hardfork bake profiles, pinned EL/CL versions, patches, immutable tags and profile test suites. Use when adding a hardfork, updating client versions, porting a bake patch or repairing artifact reuse and verification.
---

# Maintain hardfork bakes

Work from the Panda root with `deno`. Read `AGENTS.md`, the selected `bakes/<hardfork>/recipe.json`,
and the relevant `tags/<tag>.json` before changing anything. Inspect the current diff so existing
work and staging remain intact.

Use the [layout guide](../../../bakes/README.md) for file ownership and adding profiles; use the
[version guide](../../../docs/bakes.md) for CLI overrides, caches and legacy manifests. These links
resolve from the installed `.agents/skills/maintain-bakes/` directory.

## Select the change

Distinguish the hardfork profile, a future build recipe, an immutable baked artifact, and the
controller/test suite used to verify it. A recipe edit does not update an existing tag. A new tag
does not add support for a new protocol. Successful compilation alone is not compatibility.

- **Another EL/CL version within a fork:** keep the profile name, choose a new tag, and use
  supported bake overrides or update that profile's future recipe. Use `--replace` when the user's
  intent includes replacing that tag; otherwise retain the working artifact.
- **New hardfork:** add its recipe, necessary patch/native helpers and fork-specific tests under
  `bakes/<hardfork>/`, then register the recipe in `src/profiles.ts`. Check whether Engine/Beacon
  handling and phase barriers need runtime changes; declarations cannot supply missing behavior.
- **Shared implementation change:** identify which profiles consume the changed code and verify
  those being delivered with it. A profile-only edit must not trigger other client builds/suites.
- **Missing local image:** try the existing archive/digest restoration path before rebuilding. A
  tracked manifest does not carry its binary to another machine or architecture.

Keep one pipeline in `src/baker.ts`: profiles provide declarative strategies and compose shared
clocks/tests. Do not copy the builder or shared scenarios into each hardfork directory. Add only the
fork-specific behavior and files needed for the requested change.

## Pins and patches

Before editing client patches or native helpers, apply the minimal-change rule in
[develop-feature](../develop-feature/SKILL.md), including independent subagent review.

Resolve the selected upstream refs and image versions; check the actual pinned sources when porting.
Pair EL, CL, genesis, baseline client and toolchain for the fork and native platform. When
consulting upstream, use the relevant commit's code/specification rather than assuming the latest
branch matches a previously baked client.

Check `git apply --check` on the intended clean CL revision under ignored `.cache/`. The patch must
retain real signature/state validation and distinguish protocol clocks from real socket, watchdog
and RPC deadlines. For implementation use [develop-feature](../develop-feature/SKILL.md); for
changed time semantics also read the
[warp acceptance criteria](../../../docs/warp-tdd-acceptance.md).

`sourceFiles` hashes and archives extra native inputs; it does not install them into upstream.
Ensure the patch actually includes the helpers. `patch.py` is a maintainer tool, not an automatic
step of `bake`. The builder installs the shared clock and its native test from the input snapshot.

Keep generated manifests immutable: do not hand-edit bake keys, source hashes, image IDs or
verification outcomes. Native tests for an existing tag must use its exact archived inputs; recovery
from relocated files/Git requires the original hashes. Preserve legacy reading when changing layout
or artifact loading. See `tests/bake_layout_test.ts` and `tests/baker_test.ts`.

A mutable Docker tag already present locally resolves to that local image; use a digest for an
unambiguous version. `--import-cl` records an imported image, not proof that it was compiled from
the declared source or passed native tests. Do not present it as a tested native build.

## TDD and verification

For changed behavior, establish an observable failing regression before implementation; then make it
pass and refactor. Preserve red/green evidence for the selected bake. Compilation, missing
dependencies or unavailable Docker do not constitute a behavior regression. For a new fork, make
protocol compatibility assertions explicit before implementing its runtime support.

Choose checks using [test-change](../test-change/SKILL.md):

| Change                                | Verification                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Code or recipe changes                | `deno task check` and `deno task test`                                                     |
| New client artifact or fork support   | `bake <hardfork> --tag <tag>`, then `test:profile <hardfork> --bake <tag>`                 |
| Existing artifact's native regression | `test:clock <hardfork> --bake <tag>`; use its archived inputs                              |
| Shared Docker/baker behavior          | `test:baker`, separately from profile suites                                               |
| Targeted scenario/assertion change    | Relevant scenario on affected profiles; a targeted pass is not a full profile verification |
| Documentation/skill only              | Validate the changed files and references; client builds/devnets are unnecessary           |

Task names in the table run through `deno task`. A normal client bake already runs its native tests;
do not repeat a costly build or `test:clock` without a new change/failure to check.
`up --profile <hardfork> --bake <tag>` consumes an existing artifact and does not compile clients.

Keep each recipe's scenario-name-to-file map explicit. Preserve baseline, lifecycle, controlled
time/automine, warp, deposit/activation/consolidation, voluntary exit/withdrawal and dependent
deployment coverage. Add fork-specific assertions beside that fork: pinned Gloas needs separate
payload envelopes, PTC barriers and agreement with the finalized checkpoint's execution parent. Do
not infer any of these from block height or successful RPC responses alone.

Run performance-sensitive devnets sequentially, without competing builds/resource measurements. Use
the agreed warp budget from the current test and user instructions, including the next successful
transaction. Check resumed finality and signing history as well as speed. Unslashed validators do
not prove absence of inactivity penalties; honest fast-forward requires the separate economic and
duty-coverage acceptance checks.

## Evidence and failures

`test:profile` binds all scenario reports to one run ID, bake key and suite fingerprint in
`reports/profiles/<hardfork>/<tag>/verification.json`. Keep suite sources unchanged during that run.
Inspect `src/verification.ts` and `tests/verification_test.ts` when changing verification: selected
scenario routing/dependencies matter; another fork's tests and future native recipe edits must not
invalidate an unchanged baked binary.

Use `deno task bakes` to check current verification. A changed fingerprint makes prior success
historical. Standalone scenarios write their own reports/run IDs and cannot turn a failed or stale
full verification green. Record actual commands, tag/key, results, timings and unrun checks; do not
combine unrelated runs into a claimed full pass.

On a failure, retain logs and failed evidence, fix the identified cause, and rerun the original
scenario separately. Use [debug-devnet](../debug-devnet/SKILL.md) for a stalled network. Avoid
repeated unchanged runs merely to obtain green; report an unresolved cause or timing variance. Keep
compiler caches and use exact `io.panda.id` ownership for Docker cleanup; never prune globally to
repair a bake.

Update the relevant profile/version documentation with the delivered behavior and limitations.
Preserve user staging; create commits only when requested and sign them.
