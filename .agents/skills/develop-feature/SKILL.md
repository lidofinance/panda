---
name: develop-feature
description: Implement features in Panda, including Deno APIs, Docker lifecycle, and the Lighthouse clock patch.
---

Read AGENTS.md and the affected source before editing. Protocol time belongs to the Lighthouse
clock; real deadlines belong to src/http.ts. Preserve Pectra mainnet constants and real
signature/state validation.

Keep changes as small and isolated as possible. Solve problems through Panda's controller,
configuration and existing client APIs first. Change Lighthouse source only as a last resort, after
the implementing agent and independent review subagents have checked those alternatives and agree
that no reliable Panda-side solution exists. Record why the source change is unavoidable and limit
the patch to that necessity. Injected native helpers count as client source changes too.

Keep Docker calls in src/docker.ts and topology in src/network.ts. Resource ownership is the exact
io.panda.id label. Startup failure and repeated down must clean up only that id. Avoid adding
dependencies when Deno or existing dockerode suffices; pin direct versions in deno.json and retain
deno.lock.

For an unavoidable client source change, inspect the pinned upstream files and maintain the smallest
isolated patch. Validate the selected bake with maintain-bakes and test-change; never replace
networking or JWT clocks globally.

Run deno task check and deno task test; choose integration checks with test-change. Report behavior
changed, files, executed checks, and remaining limitations.
