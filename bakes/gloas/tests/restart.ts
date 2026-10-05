import { runRestart } from "../../shared/tests/restart.ts";
import { profileReport } from "../../shared/tests/report.ts";

const started = performance.now();
const samples = [];
for (const role of ["cl", "all"] as const) {
  samples.push(await runRestart(role, [3, 31, 32, 127, 128], true));
}
await profileReport(samples[0], "restart", {
  passed: true,
  elapsedMs: performance.now() - started,
  samples,
});
