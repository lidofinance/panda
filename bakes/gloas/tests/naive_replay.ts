/** Isolate real individual-attestation loss when aggregate publication fails at an epoch boundary. */
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { atomicJson } from "../../../src/artifacts.ts";
import { account, privateKey } from "../../../src/config.ts";
import { type ClockState, Consensus, executionAt } from "../../../src/consensus.ts";
import { type ConsensusMessage, replayConsensusMessages } from "../../../src/consensus_messages.ts";
import { Controller } from "../../../src/controller.ts";
import { Infrastructure } from "../../../src/docker.ts";
import { deadline, json, rpc } from "../../../src/http.ts";
import type { Manifest } from "../../../src/network.ts";
import { readBake, sha256 } from "../../../src/profiles.ts";
import { restartClients } from "./cold_restart.ts";

const voteSlot = 32;
const timeoutMs = 30_000;
const singlesPath = "/eth/v2/beacon/pool/attestations";
type Mode = "uninterrupted" | "omit-singles" | "replay";
type Attestation = { data: { slot: string }; [key: string]: unknown };
type SignedBlock = {
  data: {
    signature: string;
    message: { slot: string; state_root: string; body: { attestations: Attestation[] } };
  };
};

async function pool(m: Manifest, slot = voteSlot) {
  const result = await json<{ data: Attestation[] }>(
    `${m.beacon}/eth/v2/beacon/pool/attestations?slot=${slot}`,
  );
  return result.data.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function skippedPools(m: Manifest) {
  const pools = await Promise.all([33, 34, 35].map(async (slot) => ({
    slot,
    attestations: await pool(m, slot),
  })));
  assert(pools.every(({ attestations }) => attestations.length === 0), "skipped slots have votes");
  return pools;
}

async function state(m: Manifest, evidence: string, name: string, transaction?: string) {
  const response = await fetch(`${m.beacon}/eth/v2/debug/beacon/states/head`, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 200);
  assert(response.headers.get("content-type")?.includes("application/octet-stream"));
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 0);
  await Deno.writeFile(`${evidence}/${name}.ssz`, bytes);
  const bn = await json<ClockState>(m.bnClock);
  const vc = await json<ClockState>(m.vcClock);
  assert.equal(bn.nowMs, vc.nowMs);
  const execution = await rpc<{ hash: string }>(m.el, "eth_getBlockByNumber", ["latest", true]);
  assert.equal((await executionAt(m, "head")).block_hash, execution.hash);
  const result = {
    nowMs: bn.nowMs,
    block: await json<SignedBlock>(`${m.beacon}/eth/v2/beacon/blocks/head`),
    header: await json(`${m.beacon}/eth/v1/beacon/headers/head`),
    beaconState: { bytes: bytes.length, sha256: await sha256(bytes) },
    execution,
    balance: await rpc(m.el, "eth_getBalance", [account, "latest"]),
    nonce: await rpc(m.el, "eth_getTransactionCount", [account, "latest"]),
    receipt: transaction
      ? await rpc<{ status: string; blockHash: string } | null>(
        m.el,
        "eth_getTransactionReceipt",
        [transaction],
      )
      : null,
  };
  await atomicJson(`${evidence}/${name}.json`, result);
  return result;
}

/** Simulate an explicit publication failure, without fabricating votes or acknowledging delivery. */
function rejectCutAggregates(controller: Controller) {
  const relay = controller.network.beaconRelay;
  assert(relay, "fixture requires the managed VC relay");
  const upstream = relay.upstream;
  const stop = new AbortController();
  const rejected: { path: string; headers: [string, string][]; body: number[] }[] = [];
  const failures: string[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: stop.signal,
    onListen() {},
  }, async (request) => {
    const url = new URL(request.url);
    try {
      if (
        request.method === "POST" &&
        /^\/eth\/v[12]\/validator\/aggregate_and_proofs$/.test(url.pathname)
      ) {
        const body = new Uint8Array(await request.clone().arrayBuffer());
        const aggregates = JSON.parse(new TextDecoder().decode(body));
        assert(Array.isArray(aggregates));
        const slots = aggregates.map((value) => Number(value.message.aggregate.data.slot));
        if (slots.includes(voteSlot)) {
          assert(slots.every((slot) => slot === voteSlot), "unexpected mixed-slot aggregate batch");
          rejected.push({ path: url.pathname, headers: [...request.headers], body: [...body] });
          // The production VC logs this error and still completes its aggregate attempt barrier.
          return Response.json({ code: 503, message: "test aggregate publication failure" }, {
            status: 503,
          });
        }
      }
      return await fetch(new Request(upstream + url.pathname + url.search, request), {
        signal: AbortSignal.any([request.signal, stop.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (!stop.signal.aborted && !request.signal.aborted) failures.push(String(error));
      return new Response(String(error), { status: 503 });
    }
  });
  relay.upstream = `http://127.0.0.1:${server.addr.port}`;
  return {
    rejected,
    failures,
    async close() {
      relay.upstream = upstream;
      stop.abort();
      await server.finished;
    },
  };
}

function cutSingles(messages: ConsensusMessage[]) {
  return messages.filter((message) => message.path === singlesPath).flatMap((message) => {
    const votes: Attestation[] = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(message.body)),
    );
    return votes.filter((vote) => Number(vote.data.slot) === voteSlot);
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function sample(mode: Mode, id: string, evidence: string, sparse: boolean) {
  const cut = sparse ? 35 : voteSlot;
  await Deno.mkdir(evidence, { recursive: true });
  const controller = await Controller.start({ id, profile: "gloas" });
  const m = controller.manifest;
  let time = controller.time;
  const fault = rejectCutAggregates(controller);
  let faultClosed = false;
  try {
    await time.advanceSlots(voteSlot);
    await fault.close();
    faultClosed = true;
    assert.deepEqual(fault.failures, [], "fault proxy had an unintended forwarding failure");
    assert(fault.rejected.length > 0, "fixture did not prevent any real aggregate publication");
    await atomicJson(`${evidence}/rejected-aggregates.json`, fault.rejected);
    // No intervening proposal may transfer slot-32 singles into the persistent operation pool.
    // At slot 35 the inclusive native S-3 bound still retains them despite the sparse slots.
    if (sparse) await time.skipSlots(cut - voteSlot);
    const capture = controller.network.consensusMessages;
    assert(capture);
    const captured = capture.snapshot();
    const singles = cutSingles(captured);
    assert(singles.length > 0, "no normally verified individual votes were captured at the cut");
    await atomicJson(`${evidence}/single-votes.json`, singles);
    const before = await state(m, evidence, "before");
    assert.equal(Number(before.block.data.message.slot), voteSlot);
    assert.equal(before.nowMs - m.config.genesisTime * 1000, cut * 12_000 + 11_500);
    const beforePool = await pool(m);
    assert(beforePool.length > 0, "fixture contains no live slot-32 attestations");
    const beforeSkippedPools = sparse ? await skippedPools(m) : undefined;
    if (mode !== "uninterrupted") {
      await restartClients(
        controller,
        before.nowMs,
        evidence,
        async (restarted) => {
          const saved: ConsensusMessage[] = JSON.parse(
            await Deno.readTextFile(`${evidence}/capture-stopped.json`),
          );
          const replay = mode === "omit-singles"
            ? saved.filter((message) => message.path !== singlesPath)
            : saved;
          if (!sparse) {
            assert(replay.some((message) => message.path.endsWith("/payload_attestations")));
            assert(replay.some((message) => message.path.endsWith("/sync_committees")));
          }
          await atomicJson(`${evidence}/replayed.json`, replay);
          await replayConsensusMessages(replay, restarted.beacon, cut);
          // Read the pool while VC is absent: resumed publication cannot repair the proof.
          await atomicJson(`${evidence}/pool-before-validator.json`, await pool(restarted));
          if (sparse) {
            await atomicJson(
              `${evidence}/skipped-pools-before-validator.json`,
              await skippedPools(restarted),
            );
          }
        },
        () => atomicJson(`${evidence}/capture-stopped.json`, capture.snapshot()),
      );
      time = await Consensus.connect(m, controller.network.engine, controller.network);
    }
    const restored = await state(m, evidence, "restored");
    assert.deepEqual(restored, before, "restart changed the saved chain before advancement");
    const restoredPool = mode === "uninterrupted" ? beforePool : JSON.parse(
      await Deno.readTextFile(`${evidence}/pool-before-validator.json`),
    ) as Attestation[];
    const restoredSkippedPools = !sparse || mode === "uninterrupted"
      ? beforeSkippedPools
      : JSON.parse(
        await Deno.readTextFile(`${evidence}/skipped-pools-before-validator.json`),
      ) as Awaited<ReturnType<typeof skippedPools>>;
    const raw = await new Wallet(privateKey).signTransaction({
      chainId: m.config.chainId,
      nonce: 0,
      to: account,
      value: 1n,
      gasLimit: 21_000n,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      type: 2,
    });
    const transaction = await rpc<string>(m.el, "eth_sendRawTransaction", [raw]);
    await time.stepSlot();
    const next = await state(m, evidence, "next", transaction);
    assert.equal(Number(next.block.data.message.slot), cut + 1);
    assert.equal(next.nowMs, before.nowMs + 12_000);
    assert(next.receipt, "first post-restart transaction was not included");
    assert.equal(next.receipt?.status, "0x1", "first post-restart transaction failed");
    assert.equal(next.receipt.blockHash, next.execution.hash);
    assert.equal(next.nonce, "0x1");
    const result = {
      mode,
      cut,
      sparse,
      bake: m.bake.tag,
      bakeKey: m.bake.key,
      images: Object.fromEntries(
        Object.entries(m.bake.images).map(([role, image]) => [
          role,
          { id: image.id, platform: image.platform },
        ]),
      ),
      suppressed: fault.rejected.length,
      singles,
      before,
      beforePool,
      beforeSkippedPools,
      restored,
      restoredPool,
      restoredSkippedPools,
      next,
    };
    await atomicJson(`${evidence}/result.json`, result);
    return result;
  } catch (error) {
    const probes = await Promise.allSettled([
      json<ClockState>(m.bnClock),
      json<ClockState>(m.vcClock),
      json<SignedBlock>(`${m.beacon}/eth/v2/beacon/blocks/head`),
    ]);
    await atomicJson(`${evidence}/error.json`, {
      error: String(error),
      mode,
      controllerSlot: time.slot,
      probes: probes.map((result) =>
        result.status === "fulfilled" ? result.value : { error: String(result.reason) }
      ),
    }).catch((readback) => console.error("Could not save failure evidence", String(readback)));
    throw error;
  } finally {
    time.stop();
    try {
      if (!faultClosed) await fault.close();
    } finally {
      await controller.close();
    }
  }
}

async function supervised(mode: Mode, evidence: string, sparse: boolean) {
  const id = `naive-${crypto.randomUUID().slice(0, 8)}`;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      import.meta.filename!,
      "--sample",
      mode,
      id,
      evidence,
      ...(sparse ? ["--sparse"] : []),
    ],
    stdout: "inherit",
    stderr: "inherit",
    env: { PANDA_TIMEOUT_MS: String(timeoutMs) },
  }).spawn();
  let settled = false;
  const finished = child.status.finally(() => settled = true);
  try {
    const status = await deadline(finished, 240_000, `naive attestation ${mode}`);
    assert(status.success, `${mode} child failed; inspect ${evidence}`);
    return JSON.parse(await Deno.readTextFile(`${evidence}/result.json`)) as Awaited<
      ReturnType<typeof sample>
    >;
  } finally {
    const terminate = () => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotFound) &&
          !(error instanceof TypeError && error.message === "Child process has already terminated")
        ) throw error;
      }
    };
    try {
      terminate();
    } finally {
      try {
        await finished;
      } finally {
        await deadline(new Infrastructure(id).cleanup(), 30_000, `${id} cleanup`);
      }
    }
  }
}

export async function runNaiveReplay(omitSingles: boolean, referencePath?: string, sparse = false) {
  const cut = sparse ? 35 : voteSlot;
  const evidence = `.cache/snapshot-naive-replay/${crypto.randomUUID()}`;
  await Deno.mkdir(evidence, { recursive: true });
  let reference: Awaited<ReturnType<typeof sample>>;
  if (referencePath) {
    const bytes = await Deno.readTextFile(referencePath);
    reference = JSON.parse(bytes);
    const bake = await readBake("gloas", Deno.env.get("PANDA_BAKE") ?? "default");
    assert.equal(reference.mode, "uninterrupted");
    assert.equal(reference.cut, cut);
    assert.equal(reference.sparse ?? false, sparse);
    assert.equal(reference.bakeKey, bake.key);
    assert.equal(reference.bake, bake.tag);
    assert.deepEqual(
      reference.images,
      Object.fromEntries(
        Object.entries(bake.images).map(([role, image]) => [
          role,
          { id: image.id, platform: image.platform },
        ]),
      ),
    );
    assert(reference.suppressed > 0 && reference.singles.length > 0);
    assert(reference.beforePool.length > 0);
    assert.deepEqual(reference.restored, reference.before);
    assert.deepEqual(reference.restoredPool, reference.beforePool);
    if (sparse) {
      assert.deepEqual(
        reference.beforeSkippedPools,
        [33, 34, 35].map((slot) => ({ slot, attestations: [] })),
      );
      assert.deepEqual(reference.restoredSkippedPools, reference.beforeSkippedPools);
      assert.equal(Number(reference.before.block.data.message.slot), voteSlot);
    }
    assert.equal(Number(reference.next.block.data.message.slot), cut + 1);
    assert.equal(reference.next.nowMs, reference.before.nowMs + 12_000);
    assert.equal(reference.next.receipt?.status, "0x1");
    if (!sparse) {
      assert(
        reference.next.block.data.message.body.attestations.some((a) =>
          Number(a.data.slot) === voteSlot
        ),
      );
    }
    await atomicJson(`${evidence}/reference-reuse.json`, {
      path: referencePath,
      sha256: await sha256(bytes),
      bakeKey: bake.key,
    });
  } else {
    reference = await supervised("uninterrupted", `${evidence}/uninterrupted`, sparse);
  }
  if (!sparse) {
    assert(
      reference.next.block.data.message.body.attestations.some((a) =>
        Number(a.data.slot) === voteSlot
      ),
    );
  }
  const mode = omitSingles ? "omit-singles" : "replay";
  const restored = await supervised(mode, `${evidence}/${mode}`, sparse);
  if (omitSingles) {
    assert.equal(restored.restoredPool.length, 0, "RED did not isolate unpersisted naive votes");
    if (!sparse) {
      assert.equal(
        restored.next.block.data.message.body.attestations.some((a) =>
          Number(a.data.slot) === voteSlot
        ),
        false,
        "RED next block unexpectedly recovered the omitted individual votes",
      );
    }
  }
  const failures: string[] = [];
  for (
    const [name, actual, expected] of [
      ["bake identity", restored.bakeKey, reference.bakeKey],
      ["original signed singles", restored.singles, reference.singles],
      ["independent cut state", restored.before, reference.before],
      ["original slot-32 pool", restored.beforePool, reference.beforePool],
      ["slot-32 pool after replay", restored.restoredPool, reference.beforePool],
      [
        "skipped-slot pools before restart",
        restored.beforeSkippedPools,
        reference.beforeSkippedPools,
      ],
      [
        "skipped-slot pools after replay",
        restored.restoredSkippedPools,
        reference.beforeSkippedPools,
      ],
      ["complete signed next block", restored.next.block, reference.next.block],
      ["next state and execution", restored.next, reference.next],
    ] as const
  ) {
    try {
      assert.deepEqual(actual, expected);
    } catch {
      failures.push(name);
    }
  }
  await atomicJson(`${evidence}/comparison.json`, {
    cut,
    sparse,
    mode,
    failures,
    reference,
    restored,
  });
  console.log(
    JSON.stringify({ event: "naive-replay-compared", cut, sparse, mode, evidence, failures }),
  );
  assert.equal(failures.length, 0, `Individual attestations lost: ${failures.join("; ")}`);
}

if (import.meta.main) {
  if (Deno.args[0] === "--sample") {
    const [, mode, id, evidence, sparse] = Deno.args;
    assert(["uninterrupted", "omit-singles", "replay"].includes(mode));
    assert(sparse === undefined || sparse === "--sparse");
    await sample(mode as Mode, id, evidence, sparse === "--sparse");
  } else {
    let omitSingles = false;
    let reference: string | undefined;
    let sparse = false;
    const args = [...Deno.args];
    while (args.length) {
      const flag = args.shift();
      if (flag === "--omit-singles") omitSingles = true;
      else if (flag === "--sparse") sparse = true;
      else if (flag === "--reference") {
        reference = args.shift();
        assert(reference, "--reference requires an uninterrupted result.json");
      } else throw new Error(`Unknown argument: ${flag}`);
    }
    await runNaiveReplay(omitSingles, reference, sparse);
  }
}
