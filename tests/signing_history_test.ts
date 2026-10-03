import assert from "node:assert/strict";
import { retainedSigningHistory } from "../bakes/shared/tests/signing_history.ts";
import type { SigningHistory } from "../bakes/shared/tests/warp_assertions.ts";

Deno.test("restart comparison retains recent signatures and old per-validator watermarks", () => {
  const history: SigningHistory = {
    metadata: { genesis_validators_root: "genesis" },
    data: [
      {
        pubkey: "active",
        signed_blocks: [
          { slot: "22", signing_root: "old" },
          { slot: "64", signing_root: "boundary" },
          { slot: "98", signing_root: "latest" },
        ],
        signed_attestations: [
          { source_epoch: "0", target_epoch: "0", signing_root: "old" },
          { source_epoch: "1", target_epoch: "2", signing_root: "boundary" },
          { source_epoch: "2", target_epoch: "3", signing_root: "latest" },
        ],
      },
      {
        pubkey: "inactive",
        signed_blocks: [{ slot: "1", signing_root: "last-old-proposal" }],
        signed_attestations: [
          { source_epoch: "0", target_epoch: "0", signing_root: "last-old-vote" },
        ],
      },
    ],
  };
  const retained = retainedSigningHistory(history, 127);
  assert.deepEqual(retained.data[0].signed_blocks, history.data[0].signed_blocks.slice(1));
  assert.deepEqual(
    retained.data[0].signed_attestations,
    history.data[0].signed_attestations.slice(1),
  );
  assert.deepEqual(retained.data[1], history.data[1]);
  assert.equal(history.data[0].signed_blocks.length, 3, "must preserve original evidence");
  assert.deepEqual(retainedSigningHistory(history, 31), history);
  const corrupted = structuredClone(history);
  corrupted.data[1].signed_blocks = [];
  assert.notDeepEqual(retainedSigningHistory(corrupted, 127), retained);
  corrupted.data[1] = structuredClone(history.data[1]);
  corrupted.data[0].signed_attestations[1].signing_root = "different-vote";
  assert.notDeepEqual(retainedSigningHistory(corrupted, 127), retained);
});
