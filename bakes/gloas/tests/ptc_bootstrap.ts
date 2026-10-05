/** Real VC bootstrap faults through ordinary HTTP; no fabricated duties or clock manipulation. */
import assert from "node:assert/strict";
import { atomicJson } from "../../../src/artifacts.ts";
import { configuration } from "../../../src/config.ts";
import { type ClockState, Consensus, executionAt } from "../../../src/consensus.ts";
import { LABEL } from "../../../src/docker.ts";
import { deadline, json, rpc, waitFor } from "../../../src/http.ts";
import { type Manifest, Network } from "../../../src/network.ts";
import { readBake } from "../../../src/profiles.ts";
import type { Timeline } from "../../../src/time.ts";
import { assertFullBitvector } from "../../shared/tests/warp_assertions.ts";

const timeoutMs = 30_000;
const indexPath = /^\/eth\/v1\/beacon\/states\/head\/validators\/0x[0-9a-f]{96}$/i;

function gate(nextEpoch: number, failIndex = false) {
  return {
    nextEpoch,
    failIndex,
    bound: Promise.withResolvers<Manifest>(),
    indices: Promise.withResolvers<void>(),
    nextRequested: Promise.withResolvers<void>(),
    nextResponse: Promise.withResolvers<void>(),
    indexRequests: 0,
    dutyRequests: [] as { epoch: number; indices: string[] }[],
  };
}

/** Test-only adapter around existing lifecycle methods. Every client remains a real owned client. */
class BootstrapFault {
  current = gate(1);
  private upstream = "";
  private readonly stop = new AbortController();
  private readonly server: Deno.HttpServer<Deno.NetAddr>;
  private readonly create: Network["infra"]["container"];
  private readonly bind: Network["bindValidator"];
  readonly failures: string[] = [];

  constructor(readonly network: Network) {
    this.server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      signal: this.stop.signal,
      onListen() {},
    }, async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      const active = this.current;
      const signal = AbortSignal.any([
        request.signal,
        this.stop.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      try {
        if (request.method === "GET" && indexPath.test(path)) {
          active.indexRequests++;
          await deadline(active.indices.promise, timeoutMs, "test index response release");
          if (active.failIndex) {
            return Response.json({ code: 503, message: "test index discovery failure" }, {
              status: 503,
            });
          }
        }
        const duties = request.method === "POST" && path.match(/\/duties\/ptc\/(\d+)$/);
        if (duties) {
          active.dutyRequests.push({
            epoch: Number(duties[1]),
            indices: await request.clone().json(),
          });
        }
        const response = await fetch(new Request(this.upstream + path + url.search, request), {
          signal,
        });
        if (duties && Number(duties[1]) === active.nextEpoch && !active.failIndex) {
          active.nextRequested.resolve();
          await deadline(
            active.nextResponse.promise,
            timeoutMs,
            "test next-epoch response release",
          );
        }
        return response;
      } catch (error) {
        if (!this.stop.signal.aborted && !request.signal.aborted) this.failures.push(String(error));
        return new Response(String(error), { status: 503 });
      }
    });
    const proxy = `http://127.0.0.1:${this.server.addr.port}`;
    this.create = network.infra.container.bind(network.infra);
    network.infra.container = (role, options) => {
      if (role === "vc") {
        assert(network.beaconRelay, "bootstrap fixture requires the managed Beacon relay");
        if (network.beaconRelay.upstream !== proxy) this.upstream = network.beaconRelay.upstream;
        network.beaconRelay.upstream = proxy;
      }
      return this.create(role, options);
    };
    this.bind = network.bindValidator.bind(network);
    network.bindValidator = (manifest) => {
      this.bind(manifest);
      this.upstream = manifest.beacon;
      network.beaconRelay!.upstream = proxy;
      this.current.bound.resolve(manifest);
    };
  }

  async close() {
    this.current.indices.resolve();
    this.current.nextResponse.resolve();
    this.network.infra.container = this.create;
    this.network.bindValidator = this.bind;
    if (this.network.beaconRelay) this.network.beaconRelay.upstream = this.upstream;
    this.stop.abort();
    await this.server.finished;
  }
}

function metric(text: string, name: string, task: string): number | undefined {
  const value = text.match(new RegExp(`^${name}\\{task="${task}"\\} ([0-9.e+]+)$`, "m"));
  return value ? Number(value[1]) : undefined;
}

async function metrics(m: Manifest) {
  assert(m.vcMetrics);
  const response = await fetch(`${m.vcMetrics}/metrics`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 200);
  return await response.text();
}

async function emptyPoll<T>(
  operation: Promise<T>,
  fault: BootstrapFault,
  slot: number,
  evidence: string,
): Promise<T> {
  // Attach failure handling immediately while observing an intentionally blocked startup.
  const failure = operation.then(
    () => new Promise<never>(() => {}),
    (error) => Promise.reject(error),
  );
  failure.catch(() => {});
  const active = fault.current;
  try {
    const m = await deadline(
      Promise.race([active.bound.promise, failure]),
      180_000,
      "VC endpoints",
    );
    const observed = await waitFor("native empty PTC poll completion", async () => {
      const text = await metrics(m);
      const complete = ["update_ptc_current_epoch", "update_ptc_next_epoch"].every((task) =>
        (metric(text, "vc_duties_service_task_times_seconds_count", task) ?? 0) >= 1
      );
      return complete ? text : undefined;
    }, timeoutMs);
    assert(active.indexRequests > 0, "no real index lookup was held");
    assert.equal(active.dutyRequests.length, 0, "initial poll was not empty");
    for (const task of ["current_epoch", "next_epoch"]) {
      assert.equal(metric(observed, "vc_beacon_ptc_count", task), 0);
    }
    const [bn, vc] = await Promise.all([
      json<ClockState>(m.bnClock),
      json<ClockState>(m.vcClock),
    ]);
    const nowMs = m.config.genesisTime * 1000 + slot * 12_000 + 11_500;
    assert.equal(bn.nowMs, nowMs);
    assert.equal(vc.nowMs, nowMs);
    assert.equal(
      vc.marks.indices,
      undefined,
      "index discovery completed while responses were held",
    );
    await atomicJson(`${evidence}/empty-poll.json`, { slot, bn, vc, metrics: observed });
    active.indices.resolve();
    return await operation;
  } catch (error) {
    active.indices.resolve();
    active.nextResponse.resolve();
    await operation.catch(() => {});
    throw error;
  } finally {
    active.indices.resolve();
  }
}

async function partialCache(time: Timeline, m: Manifest, fault: BootstrapFault, evidence: string) {
  const active = fault.current;
  const slot = time.slot + 1;
  const epoch = Math.floor(slot / 32);
  const expected: number[] = [];
  for (const target of [epoch, epoch + 1]) {
    const duties = await json<{ data: unknown[] }>(
      `${m.beacon}/eth/v1/validator/duties/ptc/${target}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          Array.from({ length: m.config.validators }, (_, index) => String(index)),
        ),
      },
    );
    assert(duties.data.length > 0);
    expected.push(duties.data.length);
  }
  let completed = false;
  const advancing = time.stepSlot().then(() => completed = true);
  advancing.catch(() => {});
  try {
    await deadline(active.nextRequested.promise, timeoutMs, "real next-epoch PTC request");
    const frozen = m.config.genesisTime * 1000 + slot * 12_000 + 6_000;
    const observed = await waitFor("actual partial cache at the pre-PTC phase", async () => {
      const [bn, vc, text] = await Promise.all([
        json<ClockState>(m.bnClock),
        json<ClockState>(m.vcClock),
        metrics(m),
      ]);
      if (bn.nowMs !== frozen || vc.nowMs !== frozen) return;
      if (
        metric(text, "vc_beacon_ptc_count", "current_epoch") !== expected[0] ||
        metric(text, "vc_beacon_ptc_count", "next_epoch") !== 0
      ) return;
      return { bn, vc, metrics: text, expected };
    }, timeoutMs);
    assert.equal(completed, false, "advance passed the missing next-epoch cache");
    await atomicJson(`${evidence}/partial-cache.json`, observed);
    active.nextResponse.resolve();
    await advancing;
    const full = await metrics(m);
    for (const [index, task] of ["current_epoch", "next_epoch"].entries()) {
      assert.equal(metric(full, "vc_beacon_ptc_count", task), expected[index]);
    }
    await time.stepSlot();
    const block = await json<{
      data: {
        message: { slot: string; body: { payload_attestations: { aggregation_bits: string }[] } };
      };
    }>(`${m.beacon}/eth/v2/beacon/blocks/head`);
    assert.equal(Number(block.data.message.slot), slot + 1);
    const mask = block.data.message.body.payload_attestations.reduce(
      (bits, vote) => bits | BigInt(vote.aggregation_bits),
      0n,
    );
    assertFullBitvector(`0x${mask.toString(16)}`, 512, `post-bootstrap PTC at ${slot + 1}`);
    const execution = await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["latest", false]);
    assert.equal((await executionAt(m, "head")).block_hash, execution.hash);
    await atomicJson(`${evidence}/complete.json`, {
      bakeKey: m.bake.key,
      block,
      execution,
      metrics: full,
      dutyRequests: active.dutyRequests,
    });
  } finally {
    active.nextResponse.resolve();
    await advancing.catch(() => {});
  }
}

export async function runPtcBootstrap() {
  const previous = Deno.env.get("PANDA_TIMEOUT_MS");
  Deno.env.set("PANDA_TIMEOUT_MS", String(timeoutMs));
  try {
    await bootstrapScenarios();
  } finally {
    if (previous === undefined) Deno.env.delete("PANDA_TIMEOUT_MS");
    else Deno.env.set("PANDA_TIMEOUT_MS", previous);
  }
}

async function bootstrapScenarios() {
  const evidence = `.cache/ptc-bootstrap/${crypto.randomUUID()}`;
  const network = new Network(configuration({
    id: `ptc-bootstrap-${crypto.randomUUID().slice(0, 8)}`,
    profile: "gloas",
  }));
  assert((await readBake("gloas", network.config.bake)).recipe.ptcReadiness);
  const fault = new BootstrapFault(network);
  let time: Timeline | undefined;
  try {
    const m = await emptyPoll(network.start(), fault, 0, `${evidence}/fresh`);
    time = await Consensus.connect(m, network.engine, network);
    await partialCache(time, m, fault, `${evidence}/fresh`);
    const target = time.slot + 32;
    fault.current = gate(Math.floor(target / 32) + 1);
    await emptyPoll(time.skipSlots(32), fault, target, `${evidence}/skip`);
    await partialCache(time, m, fault, `${evidence}/skip`);
    assert.deepEqual(fault.failures, []);
    console.log(JSON.stringify({ event: "ptc-bootstrap-passed", evidence, bakeKey: m.bake.key }));
  } finally {
    time?.stop();
    try {
      await fault.close();
    } finally {
      await network.stop();
    }
  }

  const failed = new Network(configuration({
    id: `ptc-error-${crypto.randomUUID().slice(0, 8)}`,
    profile: "gloas",
  }));
  const failedFault = new BootstrapFault(failed);
  failedFault.current = gate(1, true);
  failedFault.current.indices.resolve();
  try {
    await assert.rejects(failed.start(), /Validator index discovery failed/);
    const owned = await failed.infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${failed.config.id}`] },
    });
    assert.equal(owned.length, 0, "failed bootstrap left owned clients behind");
    await atomicJson(`${evidence}/index-failure.json`, {
      indexRequests: failedFault.current.indexRequests,
      remainingOwnedClients: owned.length,
    });
  } finally {
    try {
      await failedFault.close();
    } finally {
      await failed.stop();
    }
  }
}

if (import.meta.main) await runPtcBootstrap();
