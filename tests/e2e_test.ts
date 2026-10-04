import assert from "node:assert/strict";
import { profileName, profiles } from "../src/profiles.ts";
import { defaultProfile } from "../src/active_profiles.ts";
import { scenarioArguments } from "../scripts/scenario_runner.ts";
const profile = profileName(Deno.env.get("PANDA_PROFILE") ?? defaultProfile);
const descriptions: Record<string, string> = {
  e2e: "time travel, pause, automine, finality and external indexer",
  warp: "honest 1000-slot jumps preserve every duty, economics and signing history",
  "warp-fast":
    "fast skips preserve signing history, support the next transaction and resume finality",
  "warp-economics": "full participation, no attestation penalties and finality at warp return",
  protocol: "deposit, activation and consolidation",
  withdrawal: "signed voluntary exit and complete withdrawal",
  deploy: "sequential RPC and ethers contract deployments",
  gloas: "separate payload envelope, PTC votes and phase barriers",
  restart:
    "cold BN/VC and full-client restarts preserve blocks, PTC, economics and signing history",
  resume: "managed checkpoint and resume preserve blocks, PTC, economics and signing history",
  "blob-checkpoint":
    "blob checkpoint preserves verified columns, envelopes and uninterrupted continuation",
  snapshots:
    "reusable snapshots preserve chain state and signing history through restore and removal",
  "snapshot-recovery": "explicit restore recovers every journal boundary after controller SIGKILL",
  "snapshot-creation":
    "snapshot publication and source data survive controller SIGKILL during creation",
  baseline: "ordinary unmodified clients produce an agreed execution payload",
  lifecycle: "CLI up/down/reset, ownership and profile mismatch rejection",
};
for (const [scenario, file] of Object.entries(profiles[profile].tests)) {
  Deno.test({
    name: `real ${profile}: ${descriptions[scenario] ?? scenario}`,
    ignore: Deno.env.get("PANDA_E2E") !== "1",
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: scenarioArguments(file),
        env: { PANDA_PROFILE: profile },
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      assert.equal(result.code, 0);
    },
  });
}
