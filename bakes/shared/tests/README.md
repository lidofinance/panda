# Protocol lifecycle tests

The same real Geth/Lighthouse scenarios run for active hardforks in `src/active_profiles.ts`:
currently **Gloas** only; Pectra is temporarily paused. Each `Deno.test` owns a fresh network. Its
named `t.step` stages share that network, stop on the first failed stage and always dispose their
own resources.

Start with these two readable suites:

| Suite                                    | Named stages                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [protocol_test.ts](protocol_test.ts)     | 32 ETH deposit → CL activation → compounding credentials → consolidation request/source exit → balance transfer |
| [withdrawal_test.ts](withdrawal_test.ts) | Real finality → exit eligibility → signed voluntary exit → EL withdrawal → committee rotation/final sweep       |

Consolidation explicitly increases churn capacity for the small 64-validator fixture. Eligibility
and withdrawal delays remain unchanged. The exit suite uses ordinary churn settings. Fast skips
execute real empty-slot transitions and incur inactivity penalties, so balance assertions account
for those penalties.

## Run

Use an existing compatible bake; these commands never compile Lighthouse:

```sh
# Both lifecycle suites, sequentially, for active hardforks (currently Gloas).
PANDA_BAKE=ci-main-merge deno task test:protocol

# Only one hardfork, using its selected local bake.
PANDA_PROFILE=gloas PANDA_BAKE=ci-main-merge deno task test:protocol

# Only deposit/consolidation or exit/withdrawal, across active hardforks.
PANDA_BAKE=ci-main-merge deno task e2e:protocol
PANDA_BAKE=ci-main-merge deno task e2e:withdrawal
```

Without `PANDA_BAKE`, each profile uses its `default` tag. "All hardforks" means the active profiles
using that selected bake, not every historical Panda image tag. Set `PANDA_PROFILE` to select one
profile, including an explicitly requested historical Pectra run. A newly registered hardfork joins
the direct lifecycle matrix only after it is added to the active list.

`test:profile <hardfork> --bake <tag>` and image publication CI run these same test files for their
selected hardfork, alongside the other profile checks. The scenario runner uses `deno test` for
`*_test.ts` suites and `deno run` for the existing standalone scenarios. CI displays each lifecycle
stage and fails on a failed nested step.

Successful scenario evidence is written to `reports/profiles/<hardfork>/<bake>/protocol.json` and
`withdrawal.json`. A targeted lifecycle run does not certify the full profile suite. Full
verification also binds all reports to the bake key, run ID and current suite fingerprint.

Gloas additionally registers `bakes/gloas/tests/restart.ts`. It compares real BN/VC and EL/BN/VC
cold restarts at slots 3, 31, 32, 127 and 128 with independent uninterrupted networks, including
signed blocks, PTC, subsequent transactions, participation, rewards, finality and retained signing
protection. This fixture preserves existing client data; it does not provide a snapshot API. Run it
directly with `PANDA_PROFILE=gloas PANDA_BAKE=<tag> deno run -A bakes/gloas/tests/restart.ts`.
