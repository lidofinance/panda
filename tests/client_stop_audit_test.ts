import assert from "node:assert/strict";
import { GENERATION, Infrastructure, LABEL, ROLE } from "../src/docker.ts";

function fixture(exitCode = 0, stalled = false) {
  const infra = new Infrastructure("stop-watchdog");
  const generation = crypto.randomUUID();
  infra.useGeneration(generation);
  const stopped: string[] = [];
  const filters: string[][] = [];
  infra.docker.listContainers = ((options) => {
    const labels = (options as { filters: { label: string[] } }).filters.label;
    filters.push(labels);
    const role = labels.find((label) => label.startsWith(`${ROLE}=`))!.split("=")[1];
    return Promise.resolve([{ Id: role }]);
  }) as typeof infra.docker.listContainers;
  infra.docker.getContainer = ((role: string) => ({
    inspect: () =>
      Promise.resolve({
        Config: { Labels: { [LABEL]: infra.id, [GENERATION]: generation } },
        State: { Running: !stopped.includes(role), ExitCode: exitCode, OOMKilled: false },
      }),
    stop: () => {
      stopped.push(role);
      return stalled ? new Promise<never>(() => {}) : Promise.resolve();
    },
  })) as unknown as typeof infra.docker.getContainer;
  return { infra, generation, stopped, filters };
}

Deno.test("clean preservation stops exactly its generation in VC, BN, EL order", async () => {
  const { infra, generation, stopped, filters } = fixture();
  await infra.stopClients(1000);
  assert.deepEqual(stopped, ["vc", "bn", "el"]);
  for (const labels of filters) {
    assert(labels.includes(`${LABEL}=${infra.id}`));
    assert(labels.includes(`${GENERATION}=${generation}`));
  }
});

Deno.test("force-killed validator cannot receive a clean stop result", async () => {
  const { infra, stopped } = fixture(137);
  await assert.rejects(infra.stopClients(1000), /did not stop cleanly.*137/);
  assert.deepEqual(stopped, ["vc"]);
});

Deno.test("a stalled Docker stop transport cannot outlive the preservation watchdog", async () => {
  const { infra, stopped } = fixture(0, true);
  let timer: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([
      infra.stopClients(1000).then(() => "unexpected success", () => "refused"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still waiting for Docker"), 1500);
      }),
    ]);
    assert.equal(result, "refused");
    assert.deepEqual(stopped, ["vc"]);
  } finally {
    clearTimeout(timer!);
  }
});
