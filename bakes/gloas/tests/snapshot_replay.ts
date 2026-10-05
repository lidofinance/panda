/** Positive backend proofs; the complete cut matrix and deliberate RED remain explicit runs. */
import { readBake } from "../../../src/profiles.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { runColdRestart } from "./cold_restart.ts";
import { runNaiveReplay } from "./naive_replay.ts";
import { runPtcBootstrap } from "./ptc_bootstrap.ts";

const started = performance.now();
const bake = await readBake("gloas", Deno.env.get("PANDA_BAKE") ?? "default");
await runColdRestart([3], undefined, true, 226, true);
await runNaiveReplay(false);
await runNaiveReplay(false, undefined, true);
await runPtcBootstrap();
await profileReport(
  { profile: bake.profile, bake: bake.tag, bakeKey: bake.key },
  "snapshot-replay",
  {
    event: "snapshot-replay-passed",
    elapsedMs: performance.now() - started,
    restoredCut: 3,
    continuedThrough: 226,
    naiveAttestationCut: 32,
    sparseNaiveAttestationCut: 35,
    bootstrap: ["fresh", "skip-replacement", "index-failure"],
  },
);
