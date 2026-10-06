---
name: debug-devnet
description: Diagnose stopped Panda chains, missing finality, txpool gaps, and EL/CL or external-service failures. Use when a devnet stops producing blocks, stops finalizing, does not include transactions, a payload or Engine API call stalls, a container exits, or the user asks why the chain is stuck. Prefer Panda-side fixes; for code changes use develop-feature.
---

Run deno task diagnose and inspect .panda/<id>/*.log plus manifest.json. Compare Beacon head
slot/root, current controlled clock, latest EL hash/timestamp, finalized checkpoints and validator
completion watermarks. Check container exits before waiting for API readiness.

For no blocks: confirm keys/indices, proposer duty, BN sync state, Engine API JWT and
getPayload/newPayload errors. For no finality: inspect participation, attestation/aggregate
watermarks and epoch transitions. For no inclusion: inspect txpool_content, sender nonce, balance,
fees and gas limit before advancing again. A nonce gap is not a reason to produce unbounded blocks.

Use deno task smoke:docker to isolate transport and deno task baseline to isolate clock changes.
Preserve failing logs before deno task reset. Never restart unrelated containers or run global
Docker prune.

Report the failing boundary, evidence, hypothesis, smallest reproduction and the verification
result. Separate observed causes from guesses.

For a current payload stall, inspect `src/engine.ts` and Geth JSON `Updated payload` messages. The
gate must suppress future-slot attributes, wait for the current full payload and preserve real-time
JWT validation. A missing event must time out visibly. After `skipSlots`, read updated VC endpoints
from manifest.json; Docker Desktop may not immediately release old private ports.

Prefer Panda-side fixes. Before changing client source, apply the minimal-change rule in
[develop-feature](../develop-feature/SKILL.md), including independent subagent review.
