import assert from "node:assert/strict";
import { dockerClient, Infrastructure, LABEL, ROLE } from "../src/docker.ts";

function clients(
  logs: Record<string, string>,
  fail?: { role: string; exit?: number; foreign?: boolean },
) {
  const docker = dockerClient();
  const calls: string[] = [];
  const stopped = new Set<string>();
  docker.listContainers = (() =>
    Promise.resolve(
      ["el", "bn", "vc"].map((role) => ({
        Id: role,
        Labels: { [LABEL]: "snapshot-stop", [ROLE]: role },
        State: stopped.has(role) ? "exited" : "running",
      })),
    )) as unknown as typeof docker.listContainers;
  docker.getContainer = ((role: string) => ({
    inspect: () =>
      Promise.resolve({
        Config: {
          Labels: {
            [LABEL]: fail?.foreign && fail.role === role ? "other" : "snapshot-stop",
            [ROLE]: role,
          },
        },
        State: {
          Running: !stopped.has(role),
          OOMKilled: false,
          ExitCode: fail?.role === role ? fail.exit ?? 0 : 0,
        },
      }),
    stop: () => {
      calls.push(role);
      stopped.add(role);
      return Promise.resolve();
    },
  })) as unknown as typeof docker.getContainer;
  const infra = new Infrastructure("snapshot-stop", docker);
  infra.logs =
    ((container: { inspect(): Promise<{ Config: { Labels: Record<string, string> } }> }) =>
      container.inspect().then((info) =>
        logs[info.Config.Labels[ROLE]] ?? ""
      )) as typeof infra.logs;
  return { infra, calls, docker };
}
const stop = (infra: Infrastructure) =>
  (infra as Infrastructure & { stopClients(timeout: number): Promise<void> }).stopClients(10000);

Deno.test("snapshot stop requires current BN persistence acknowledgement before stopping EL", async () => {
  const { infra, calls, docker } = clients({
    vc: "shutdown",
    bn: "shutdown",
    el: "Blockchain stopped",
  });
  const list = docker.listContainers;
  docker.listContainers =
    ((options: { filters: { label: string[] } }) =>
      list().then((rows) =>
        rows.filter((row) => options.filters.label.includes(`${ROLE}=${row.Id}`))
      )) as unknown as typeof docker.listContainers;
  await assert.rejects(stop(infra), /persistence/);
  assert.deepEqual(calls, ["vc", "bn"]);
});
Deno.test("snapshot stop rejects killed clients and foreign ownership", async () => {
  for (const fail of [{ role: "vc", exit: 137 }, { role: "vc", foreign: true }]) {
    const { infra, docker } = clients({}, fail);
    const list = docker.listContainers;
    docker.listContainers = ((options: { filters: { label: string[] } }) =>
      list().then((rows) =>
        rows.filter((row) =>
          options.filters.label.includes(`${ROLE}=${row.Id}`)
        )
      )) as unknown as typeof docker.listContainers;
    await assert.rejects(stop(infra), /cleanly|Foreign/);
  }
});
Deno.test("snapshot stop orders VC BN EL and requires positive BN and EL persistence", async () => {
  const { infra, calls, docker } = clients({
    bn: "Saved beacon chain to disk",
    el: '{"msg":"Persisted dirty state to file"}\n{"msg":"Blockchain stopped"}',
  });
  const list = docker.listContainers;
  docker.listContainers =
    ((options: { filters: { label: string[] } }) =>
      list().then((rows) =>
        rows.filter((row) => options.filters.label.includes(`${ROLE}=${row.Id}`))
      )) as unknown as typeof docker.listContainers;
  await stop(infra);
  assert.deepEqual(calls, ["vc", "bn", "el"]);
});

Deno.test("snapshot stop rejects Geth journal failure even when clean exit says Blockchain stopped", async () => {
  const { infra, docker } = clients({
    bn: "Saved beacon chain to disk",
    el: "Failed to journal in-memory trie nodes\nBlockchain stopped",
  });
  const list = docker.listContainers;
  docker.listContainers =
    ((options: { filters: { label: string[] } }) =>
      list().then((rows) =>
        rows.filter((row) => options.filters.label.includes(`${ROLE}=${row.Id}`))
      )) as unknown as typeof docker.listContainers;
  await assert.rejects(stop(infra), /persistence/);
});
