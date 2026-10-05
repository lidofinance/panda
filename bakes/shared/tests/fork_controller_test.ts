/** P1 unit counterexamples for the existing adapters. These are not fork-transition E2E tests. */
import assert from "node:assert/strict";
import { Consensus, executionAt, finalizedExecutionHash } from "../../../src/consensus.ts";
import type { Manifest } from "../../../src/network.ts";
import { profiles } from "../../../src/profiles.ts";

async function beforeGloas(test: (manifest: Manifest, paths: string[]) => Promise<void>) {
  const paths: string[] = [];
  const payload = { block_hash: `0x${"12".repeat(32)}`, timestamp: "84" };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path.includes("/beacon/blocks/")) {
      return Response.json({
        version: "electra",
        execution_optimistic: false,
        data: { message: { slot: "7", body: { execution_payload: payload } } },
      });
    }
    if (path.includes("/execution_payload_envelopes/")) {
      return new Response("pre-Gloas block", { status: 404 });
    }
    if (path.endsWith("/committees")) {
      return Response.json({ data: [{ index: "0", validators: ["0", "1"] }] });
    }
    return Response.json({
      nowMs: 88_000,
      marks: { attestations_0: 7, attestations: 7, sync_messages: 7 },
    });
  });
  const url = `http://127.0.0.1:${server.addr.port}`;
  // Same binary family, earlier active fork. Supply its phase table without introducing a new API.
  const manifest = {
    config: { profile: "gloas", genesisTime: 0 },
    bake: {
      recipe: {
        ...profiles.gloas,
        phases: profiles.pectra.phases,
        attestationMs: 4000,
        aggregateMs: 8000,
        directSync: false,
      },
    },
    beacon: url,
    bnClock: `${url}/bn`,
    vcClock: `${url}/vc`,
  } as unknown as Manifest;
  try {
    await test(manifest, paths);
  } finally {
    await server.shutdown();
  }
}

Deno.test("Gloas binary family reads a pre-Gloas block's inline execution payload", async () => {
  await beforeGloas(async (m) => {
    assert.equal((await executionAt(m, "head")).timestamp, "84");
  });
});

Deno.test("Gloas binary family reads pre-Gloas finalized execution from the checkpoint block", async () => {
  await beforeGloas(async (m) => {
    assert.equal(await finalizedExecutionHash(m), `0x${"12".repeat(32)}`);
  });
});

Deno.test("Electra attestation phase uses committee marks even in the Gloas binary family", async () => {
  await beforeGloas(async (m, paths) => {
    await new Consensus(m).move(88_000, 4000);
    assert(
      paths.includes("/vc/wait/7/30000/attestations_0,sync_messages"),
      `wrong active-fork barrier: ${paths.join(", ")}`,
    );
  });
});
