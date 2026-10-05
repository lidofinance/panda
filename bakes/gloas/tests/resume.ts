import { runRestart } from "../../shared/tests/restart.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { checkpointGuards } from "./checkpoint_guards.ts";
import { runAdmission } from "../../shared/tests/admission.ts";

const started = performance.now();
const guards = await checkpointGuards();
const admission = await runAdmission();
const sample = await runRestart("managed", [3, 31, 32, 127, 128], true);
await profileReport(sample, "resume", {
  passed: true,
  elapsedMs: performance.now() - started,
  sample,
  guards,
  admission,
});
