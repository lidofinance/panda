import assert from "node:assert/strict";
import { ConsensusMessages } from "../src/consensus_messages.ts";
import type { Manifest } from "../src/network.ts";
import {
  captureSavedState,
  snapshotRequestSupported,
  validateSavedState,
} from "../src/saved_state.ts";

const root = (byte: string) => `0x${byte.repeat(64)}`;

async function fixture(
  run: (f: {
    manifest: Manifest;
    nowMs: number;
    messages: ConsensusMessages;
    replies: Record<string, unknown>;
    requests: string[];
  }) => Promise<void>,
  slot = 3,
  headSlot = slot,
) {
  const nowMs = slot * 12_000 + 11_500;
  const manifest = {
    config: { profile: "gloas", mode: "controlled", genesisTime: 0 },
    bake: { recipe: { ptcReadiness: true } },
    bnClock: "http://fixture/bn",
    vcClock: "http://fixture/vc",
    beacon: "http://fixture",
    el: "http://fixture/el",
  } as Manifest;
  const optimistic = { execution_optimistic: false };
  const bid = { block_hash: headSlot ? root("3") : root("0"), parent_block_hash: root("3") };
  const replies: Record<string, unknown> = {
    "/bn": { nowMs, marks: {} },
    "/vc": { nowMs, marks: {} },
    "/eth/v1/beacon/headers/head": {
      ...optimistic,
      data: {
        root: root("1"),
        canonical: true,
        header: { message: { slot: String(headSlot), state_root: root("2") } },
      },
    },
    [`/eth/v2/beacon/blocks/${root("1")}`]: {
      ...optimistic,
      data: {
        message: {
          slot: String(headSlot),
          body: { signed_execution_payload_bid: { message: bid } },
        },
      },
    },
    [`/eth/v1/beacon/execution_payload_envelopes/${root("1")}`]: {
      ...optimistic,
      data: {
        message: {
          payload: {
            slot_number: String(headSlot),
            block_hash: root("3"),
            timestamp: String(headSlot * 12),
          },
        },
      },
    },
    "/eth/v1/beacon/states/head/root": { ...optimistic, data: { root: root("4") } },
    "/eth/v1/beacon/states/head/finality_checkpoints": {
      ...optimistic,
      data: { finalized: { epoch: "0", root: root("0") } },
    },
    "/eth/v1/node/syncing": {
      data: { is_syncing: false, is_optimistic: false, el_offline: false },
    },
    "txpool_status": { pending: "0x0", queued: "0x0" },
    "eth_getBlockByNumber:latest": {
      hash: root("3"),
      number: `0x${headSlot.toString(16)}`,
      timestamp: `0x${(headSlot * 12).toString(16)}`,
    },
  };
  const fetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/el") {
      const call = JSON.parse(String(init?.body));
      const key = call.method === "eth_getBlockByNumber"
        ? `${call.method}:${call.params[0]}`
        : call.method;
      requests.push(key);
      assert(key in replies, `Unexpected RPC ${key}`);
      return Promise.resolve(Response.json({ result: replies[key] }));
    }
    requests.push(path);
    assert(path in replies, `Unexpected request ${path}`);
    return Promise.resolve(Response.json(replies[path]));
  };
  try {
    await run({ manifest, nowMs, replies, requests, messages: new ConsensusMessages(() => slot) });
  } finally {
    globalThis.fetch = fetch;
  }
}

Deno.test("saved-state capture preserves sparse heads and validates before starting VC", async () => {
  await fixture(
    async ({ manifest, nowMs, messages, requests }) => {
      const saved = await captureSavedState(manifest, nowMs, messages);
      assert.equal(saved.schema, 2);
      assert.equal(saved.slot, 35);
      assert.equal(saved.headSlot, 32);
      assert.equal(
        saved.headStateRoot,
        root("4"),
        "use actual head state, not pre-envelope block root",
      );
      assert.equal(saved.executionBlockHash, root("3"));
      assert.deepEqual(saved.replayMessages, []);
      requests.length = 0;
      await validateSavedState({ ...manifest, vcClock: "http://not-started/vc" }, saved);
      assert(!requests.includes("/vc"), "restore must be checked with VC absent");
    },
    35,
    32,
  );
});

Deno.test("fresh genesis is capturable without a nonexistent execution envelope", async () => {
  await fixture(async ({ manifest, nowMs, messages, requests }) => {
    const saved = await captureSavedState(manifest, nowMs, messages);
    assert.equal(saved.headSlot, 0);
    await validateSavedState(manifest, saved);
    assert(!requests.some((path) => path.includes("execution_payload_envelopes")));
  }, 0);
});

Deno.test("capture refuses unfinished time, unsettled transactions and unhealthy consensus", async (t) => {
  const faults: Record<string, (f: Parameters<Parameters<typeof fixture>[0]>[0]) => void> = {
    "clock mismatch": ({ replies }) => {
      replies["/vc"] = { nowMs: 1, marks: {} };
    },
    "pending tx": ({ replies }) => {
      replies.txpool_status = { pending: "0x1", queued: "0x0" };
    },
    "queued tx": ({ replies }) => {
      replies.txpool_status = { pending: "0x0", queued: "0x1" };
    },
    "optimistic head": ({ replies }) => {
      (replies["/eth/v1/beacon/headers/head"] as Record<string, unknown>).execution_optimistic =
        true;
    },
    "noncanonical head": ({ replies }) => {
      (replies["/eth/v1/beacon/headers/head"] as { data: { canonical: boolean } }).data.canonical =
        false;
    },
    "EL offline": ({ replies }) => {
      replies["/eth/v1/node/syncing"] = {
        data: { is_syncing: false, is_optimistic: false, el_offline: true },
      };
    },
    "envelope mismatch": ({ replies }) => {
      replies[`/eth/v1/beacon/execution_payload_envelopes/${root("1")}`] = {
        execution_optimistic: false,
        data: {
          message: { payload: { slot_number: "3", block_hash: root("9"), timestamp: "36" } },
        },
      };
    },
    "EL disagreement": ({ replies }) => {
      replies["eth_getBlockByNumber:latest"] = {
        hash: root("9"),
        number: "0x3",
        timestamp: "0x24",
      };
    },
  };
  for (const [name, change] of Object.entries(faults)) {
    await t.step(name, () =>
      fixture(async (f) => {
        change(f);
        await assert.rejects(captureSavedState(f.manifest, f.nowMs, f.messages));
      }));
  }
  await fixture(async ({ manifest, messages }) => {
    await assert.rejects(captureSavedState(manifest, 36_000, messages), /completed slot/);
  });
});

Deno.test("saved-state restore rejects changed chain anchors before VC activation", async (t) => {
  for (
    const field of [
      "headBlockRoot",
      "headStateRoot",
      "executionBlockHash",
      "finalizedRoot",
    ] as const
  ) {
    await t.step(field, () =>
      fixture(async ({ manifest, nowMs, messages }) => {
        const saved = await captureSavedState(manifest, nowMs, messages);
        await assert.rejects(
          validateSavedState(manifest, { ...saved, [field]: root("9") }),
          /mismatch/,
        );
      }));
  }
});

Deno.test("capture propagates replay-buffer refusal before any network mutation", async () => {
  await fixture(async ({ manifest, nowMs, messages }) => {
    messages.snapshot = () => {
      throw new Error("Unresolved consensus submission");
    };
    await assert.rejects(captureSavedState(manifest, nowMs, messages), /Unresolved consensus/);
  });
});

Deno.test("saved-state finality uses the Gloas checkpoint execution parent", async () => {
  await fixture(async ({ manifest, nowMs, messages, replies }) => {
    replies["/eth/v1/beacon/states/head/finality_checkpoints"] = {
      execution_optimistic: false,
      data: { finalized: { epoch: "1", root: root("5") } },
    };
    replies[`/eth/v2/beacon/blocks/${root("5")}`] = {
      execution_optimistic: false,
      data: {
        message: {
          slot: "32",
          body: {
            signed_execution_payload_bid: {
              message: { block_hash: root("6"), parent_block_hash: root("7") },
            },
          },
        },
      },
    };
    replies["eth_getBlockByNumber:finalized"] = { hash: root("7") };
    const saved = await captureSavedState(manifest, nowMs, messages);
    assert.equal(saved.finalizedEpoch, 1);
    await validateSavedState(manifest, saved);
    replies["eth_getBlockByNumber:finalized"] = { hash: root("6") };
    await assert.rejects(validateSavedState(manifest, saved), /Finalized EL\/CL disagreement/);
  }, 64);
});

Deno.test("snapshot ingress permits captured votes, persisted pools and read-only Beacon POSTs", () => {
  for (
    const path of [
      "/eth/v1/beacon/pool/payload_attestations",
      "/eth/v2/beacon/pool/attestations",
      "/eth/v1/beacon/pool/sync_committees",
      "/eth/v1/beacon/pool/voluntary_exits",
      "/eth/v1/beacon/pool/proposer_slashings",
      "/eth/v2/beacon/pool/attester_slashings",
      "/eth/v1/beacon/pool/bls_to_execution_changes",
      "/eth/v1/beacon/states/head/validators",
      "/eth/v1/beacon/states/head/validator_balances",
      "/eth/v1/validator/duties/ptc/4",
      "/eth/v1/validator/duties/sync/4",
      "/eth/v1/validator/duties/attester/4",
      "/eth/v1/validator/liveness/4",
      "/eth/v1/beacon/rewards/attestations/4",
      "/eth/v1/beacon/rewards/sync_committee/head",
    ]
  ) assert.equal(snapshotRequestSupported("beacon", "POST", path), true, path);
  assert.equal(snapshotRequestSupported("vc", "GET", "/eth/v1/keystores"), true);
  assert.equal(snapshotRequestSupported("vc", "DELETE", "/eth/v1/keystores"), false);
  assert.equal(
    snapshotRequestSupported("beacon", "DELETE", "/eth/v1/beacon/pool/voluntary_exits"),
    false,
  );
});
