# Honest / fast — 2026-09-30

Selected client: Gloas `direct-sync`, unchanged. Both modes use the same bake. Pectra was tested
independently on its existing `panda` artifact. No client rebuild or new cryptographic optimization.
The complete earlier experiment index is [docs/warp-experiments.md](../../docs/warp-experiments.md).

## Executed checks

| Check                                                              | Result                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `./scripts/deno test -A tests/time_test.ts tests/warp_api_test.ts` | 13 PASS                                                             |
| `./scripts/deno test -A tests/warp_rewards_test.ts`                | 2 PASS                                                              |
| `./scripts/deno task test`                                         | 42 PASS, 0 failed, 13 opt-in ignored                                |
| `./scripts/deno task check`                                        | PASS                                                                |
| Gloas fast, twice 8192 + first tx                                  | PASS, 8.286 / 8.633 seconds                                         |
| Pectra fast, twice 8192 + first tx                                 | PASS, 15.181 / 15.510 seconds                                       |
| Gloas honest, twice 96 + first tx                                  | PASS, 8.592 / 8.662 seconds                                         |
| Gloas honest economics, twice 96                                   | PASS, advance 8.526 / 8.490 seconds; deploy 0.106 / 0.100 seconds   |
| Gloas missing required sync key                                    | Bounded failure PASS, 30.078 seconds                                |
| Pectra honest economics, twice 96                                  | PASS, advance 32.223 / 32.039 seconds; deploy 0.371 / 0.466 seconds |

Live commands, executed sequentially:

```sh
PANDA_PROFILE=gloas PANDA_BAKE=direct-sync ./scripts/deno run -A bakes/shared/tests/warp_fast.ts
PANDA_PROFILE=pectra PANDA_BAKE=panda ./scripts/deno run -A bakes/shared/tests/warp_fast.ts
PANDA_PROFILE=gloas PANDA_BAKE=direct-sync ./scripts/deno run -A reports/warp-modes/honest-short.ts
PANDA_PROFILE=gloas PANDA_BAKE=direct-sync ./scripts/deno run -A bakes/shared/tests/warp_economics.ts
PANDA_PROFILE=pectra PANDA_BAKE=panda ./scripts/deno run -A bakes/shared/tests/warp_economics.ts
```

The short honest helper was run from `.cache/warp-modes/honest-short.ts`; the identical source is
retained here. `*.log` files preserve stdout/stderr, and matching `*.json` files preserve reports.
[results.json](results.json) records artifact keys, report hashes, final source fingerprints and the
exact five test network IDs. Final source fingerprints identify the resulting implementation; they
do not substitute for the baker's suite verification. The short fixture parameter and honest
watchdog were added after the fast runs; the default fast path did not change.

Fast checks include actual EL/CL agreement, the next transaction in the next block, paused protocol
time, resumed real finality and retained signing history for all 64 validators. Fast permits missed
duties, penalties and stale finality during the gap; no slashing was observed. Honest short checks
cover full block/sync duty coverage and rewards; economics adds participation, inactivity and
contract deployment. Gloas economics also covers PTC and missing-key failure.

## RED / GREEN and earlier evidence

- `red/time-unit.log`: four behavioral failures before adding modes; eight old tests passed.
- `red/profile-routing.log`: missing independent fast suite mappings.
- `red/rewards.log`: reproduces pruned historical rewards with deferred observation.
- `green/`: passing time/API, streaming rewards, full unit and check logs.
- `red/api-permission-error.log`: sandbox prevented localhost binding; not behavioral RED.
- `red/check-format-error.log`: formatting failure with an English translation of the original
  excerpt; not behavioral RED.
- `baseline.json`: all eight native inputs match the selected immutable Gloas bake.
- `previous-warp.ts`: full test before the two-mode change and streaming rewards observer.
- `previous-*-economics.json`: previous reports preserved before replacement. The Gloas copy was
  recovered from its original stdout, also saved under `reports/warp-tdd/native/`.
- [Native experiments](../warp-tdd/native/README.md),
  [same-message verification](../warp-tdd/same-message/README.md),
  [shared hash signing](../warp-tdd/shared-hash/README.md),
  [group aggregation](../warp-tdd/group-sync/README.md): retained raw evidence and prototypes.

## Limits

Full honest two ×8192 was not repeated. The older Gloas test failed while reading pruned rewards
after about 12m40s; this is not a full successful benchmark. The new streaming observer passed its
regression and a real 96-slot test, but full long-run validation remains outstanding. No complete
`test:profile`, new Pectra direct-sync build, or complete honest lifecycle/failure matrix is
claimed. No `verification.json` was manually marked passing. Commits were not requested or created.
