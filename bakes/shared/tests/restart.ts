/** P1 regression: cold client restart, not a snapshot API or a profile certification. */
import assert from "node:assert/strict";
import { Controller } from "../../../src/controller.ts";
import { type ClockState, Consensus, executionAt } from "../../../src/consensus.ts";
import { LABEL, ROLE } from "../../../src/docker.ts";
import { EngineGate } from "../../../src/engine.ts";
import { json, rpc, waitFor } from "../../../src/http.ts";
import { clockEnvironment } from "../../../src/profiles.ts";

type Block = {
  version: string;
  data: {
    signature: string;
    message: { slot: string; state_root: string; body: Record<string, unknown> };
  };
};
type Restart = "none" | "cl" | "all";

async function sample(restart: Restart) {
  const c = await Controller.start({ id: `restart-${restart}-${crypto.randomUUID().slice(0, 8)}` });
  const m = c.manifest;
  const infra = c.network.infra;
  try {
    await c.time.advanceSlots(3);
    const before = await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`);
    const beforeEl = await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["latest", false]);
    const clock = await json<ClockState>(m.bnClock);
    assert.equal(clock.nowMs, (await json<ClockState>(m.vcClock)).nowMs);
    assert.equal(clock.marks.fork_choice, 3, "cut must follow the fork-choice barrier");
    if (restart !== "none") {
      const roles = restart === "all" ? ["vc", "bn", "el"] : ["vc", "bn"];
      const saved = [];
      // Reverse dependency order, graceful exits, exact owner, retained volumes and signing DB.
      for (const role of roles) {
        const found = await infra.docker.listContainers({
          all: true,
          filters: { label: [`${LABEL}=${m.config.id}`, `${ROLE}=${role}`] },
        });
        assert.equal(found.length, 1, `expected one owned ${role}`);
        const container = infra.docker.getContainer(found[0].Id);
        const info = await container.inspect();
        assert.equal(info.Config.Labels?.[LABEL], m.config.id);
        await container.stop({ t: 60 });
        const stopped = await container.inspect();
        assert.equal(stopped.State.OOMKilled, false);
        assert.equal(stopped.State.ExitCode, 0, `${role} did not stop gracefully`);
        await Deno.writeTextFile(
          `${m.directory}/${role}-before-restart.log`,
          await infra.logs(container),
        );
        saved.push({ role, info });
        await container.remove();
      }
      if (restart === "all") await c.network.engine?.close();
      for (const { role, info } of saved.reverse()) {
        const { startMs } = clockEnvironment(m.bake.recipe);
        const env = (info.Config.Env ?? []).filter((entry) => !entry.startsWith(`${startMs}=`));
        const network = info.HostConfig.NetworkMode;
        assert(network, "owned container must have a Docker network");
        const container = await infra.container(role, {
          Image: info.Image,
          User: info.Config.User,
          Entrypoint: info.Config.Entrypoint,
          Cmd: info.Config.Cmd?.map((arg) =>
            arg.startsWith("--execution-endpoint=")
              ? `--execution-endpoint=${c.network.engine!.url}`
              : arg
          ).filter((arg) => arg !== "--init-slashing-protection"),
          Env: role === "el" ? env : [...env, `${startMs}=${clock.nowMs}`],
          ExposedPorts: info.Config.ExposedPorts,
          HostConfig: { ...info.HostConfig, PortBindings: info.NetworkSettings.Ports },
          NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [role] } } },
        });
        await container.start();
        const port = (n: number) => info.NetworkSettings.Ports[`${n}/tcp`]?.[0]?.HostPort;
        if (role === "el") {
          await waitFor("restarted Geth", () => rpc(m.el, "eth_chainId"));
          c.network.engine = await EngineGate.start(
            infra,
            container,
            `http://127.0.0.1:${port(8551)}`,
            clock.nowMs,
            await Deno.readTextFile(`${m.directory}/jwt/jwtsecret`),
          );
        } else if (role === "bn") {
          await waitFor("restarted beacon", () => json(`${m.beacon}/eth/v1/beacon/headers/head`));
        } else {
          await waitFor("restarted validator duties", async () => {
            const state = await json<ClockState>(m.vcClock);
            return state.nowMs === clock.nowMs && state.marks.ready === 0 &&
                state.marks.indices !== undefined
              ? true
              : undefined;
          });
        }
      }
      assert.deepEqual(
        await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`),
        before,
        "restart changed the checkpoint block",
      );
      assert.equal(
        (await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["latest", false])).hash,
        beforeEl.hash,
        "restart changed EL head",
      );
    }
    const timeline = await Consensus.connect(m, c.network.engine);
    await timeline.stepSlot();
    const next = await json<Block>(`${m.beacon}/eth/v2/beacon/blocks/head`);
    assert.equal(next.data.message.slot, "4");
    assert.equal(
      (await executionAt(m, "head")).block_hash,
      (await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["latest", false])).hash,
    );
    return {
      bakeKey: m.bake.key,
      bake: m.bake.tag,
      profile: m.config.profile,
      before: before.data.message,
      next: next.data.message,
      beforeSignature: before.data.signature,
      nextSignature: next.data.signature,
    };
  } finally {
    await c.close();
  }
}

const selected = Deno.args[0];
if (selected !== "cl" && selected !== "all") throw new Error("Usage: restart.ts cl|all");
// Bound failures in this diagnostic scenario; do not change the runtime watchdog default.
if (!Deno.env.has("PANDA_TIMEOUT_MS")) Deno.env.set("PANDA_TIMEOUT_MS", "60000");
const uninterrupted = await sample("none");
const resumed = await sample(selected);
await Deno.mkdir(".cache/p0-p1", { recursive: true });
await Deno.writeTextFile(
  `.cache/p0-p1/restart-${resumed.profile}-${resumed.bake}-${selected}.json`,
  JSON.stringify({ uninterrupted, resumed }, null, 2),
);
assert.equal(resumed.bakeKey, uninterrupted.bakeKey);
assert.deepEqual(
  resumed.before,
  uninterrupted.before,
  "comparison networks must have the same checkpoint",
);
// Includes every aggregation bit and signature, PTC data, execution bid/payload, and resulting state.
assert.equal(resumed.beforeSignature, uninterrupted.beforeSignature);
assert.deepEqual(resumed.next, uninterrupted.next, "cold restart lost next-block state or duties");
assert.equal(resumed.nextSignature, uninterrupted.nextSignature, "next block signature changed");
console.log(
  JSON.stringify({
    event: "restart-passed",
    profile: resumed.profile,
    bakeKey: resumed.bakeKey,
    restart: selected,
  }),
);
