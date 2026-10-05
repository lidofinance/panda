# Panda

Branding and mascot notes: [docs/branding.md](docs/branding.md).

One Deno controller drives dockerode, Geth, Lighthouse BN/VC and a one-shot genesis container. The
profiles are named by hardfork: Pectra (Prague/Electra) and Gloas (Amsterdam/Gloas), mainnet preset,
12-second slots. Protocol time is explicit; sockets, RPC deadlines, watchdogs and profiling use real
time. Never substitute a mock EL, signature bypass or a fabricated finalized checkpoint.

## Working approach

Start from the user's current goal; reuse established findings and keep plans current. Prefer the
smallest maintainable solution across Panda and its clients. Solve problems through Panda,
infrastructure, configuration and existing APIs first. Change Lighthouse only when those cannot
reliably meet a concrete requirement, after independent subagent review, and keep the patch minimal.
Have reviewers challenge alternatives and counterexamples together before implementing a design;
justifying the current code does not establish that its architecture is necessary. Count injected
helpers in the client diff. Explain the idea and tradeoffs plainly, preserve useful evidence, and
distinguish source-reviewed proposals from executed verification.

Requires Deno 2.9.7 on `PATH` and a running local Docker daemon.

Commands: `deno task smoke:docker`; `deno task check`; `deno task test`; `deno task baseline`;
`deno task up`; `deno task down`; `deno task reset`; `deno task diagnose`; `deno task profile`.
Tasks use the installed `deno` command. Client builds are separate from `up`: use
`deno task bake <hardfork> --tag <tag>`, then `deno task test:profile <hardfork> --bake <tag>` and
`deno task up --profile <hardfork> --bake <tag>`.

Use `.agents/skills/maintain-bakes/SKILL.md` for hardfork profiles, client versions, patches, tags
and bake verification. Use `.agents/skills/develop-feature/SKILL.md` for implementation,
`test-change/SKILL.md` for validation, `review-changes/SKILL.md` for review, `debug-devnet/SKILL.md`
for stalled chains, and `profile-resources/SKILL.md` for measurements. Read the selected skill,
execute its relevant commands, and record actual results. Never report an unexecuted integration
scenario as passing.

TDD is mandatory: define observable acceptance criteria and add a failing regression before
implementing or optimizing the affected behavior, then make it pass and refactor with the same
checks. For honest fast-forward use `docs/warp-tdd-acceptance.md`. Validator economics, full duty
coverage, real finality, EL/CL agreement, failure safety and post-warp operations are release gates;
speed or `slashed == false` alone is insufficient. Preserve red/green evidence for the selected
bake. A requirement without an implemented, executed check remains unverified. Profile builds and
tests stay independent; shared changes require validation for each profile released with them.

Sources: `src/network.ts` owns lifecycle; `src/docker.ts` owns Docker operations; `src/config.ts`
owns runtime configuration; `bakes/*/recipe.json` pins recipes; `src/baker.ts` builds immutable
`bakes/<hardfork>/tags/<tag>.json` manifests; `src/engine.ts` gates payload preparation using pinned
Geth JSON logs; `bakes/shared/controlled_clock.rs` owns protocol time and completion marks. The
Lighthouse patch also contains controlled duty delivery, verification reuse and prepared-skip
support where declared by the bake. See `docs/warp-algorithm.md` for the current algorithms and
source map. `src/http.ts` contains real bounded waits. Keep third-party source/build artifacts under
ignored `.cache/`. All Docker mutations must be scoped by the exact `io.panda.id` label. Never prune
Docker globally: this machine may have unrelated running workloads.

Before tracking reports, remove personal checkout paths and unrelated Docker workload names/IDs.
Keep original private evidence in ignored `.cache/`; preserve numeric measurements, bake identities
and pass/fail results in public copies. Session handoffs and external pilot dumps stay outside Git.

Extended verification: `deno task e2e`, `e2e:withdrawal`, `e2e:protocol`, `test:lifecycle`,
`test:clock <hardfork> --bake <tag>`, `measure`. Raw profile reports are tracked under
`reports/profiles/<hardfork>/<tag>/`; verification binds the bake key and suite fingerprint. Gloas
uses separate payload envelopes and PTC barriers; finalized execution is the checkpoint's execution
parent. Both warp modes use real state transitions. Default honest mode executes all duties and may
take minutes; explicit fast mode skips slots and permits inactivity penalties, never conflicting
signatures. Fast jumps must complete in seconds including the first subsequent transaction.
`e2e:warp` checks two honest 1000-slot jumps; `e2e:warp-fast` checks two fast 8192-slot jumps with
the next transaction, resumed finality and signing history. `e2e:warp-economics` checks short honest
participation and rewards. Modes share a bake; do not build separate clients merely to select a
mode. `test:profile` runs only the selected profile; `test:baker` owns shared Docker/baker checks.
Do not run resource measurements concurrently with another devnet test. Public HTTP endpoints are
localhost-only; the internal Engine gate binds the host gateway and verifies JWT before forwarding.
