---
name: test-change
description: Select and run meaningful unit, Docker, and real EL/CL regression tests for Panda changes. Use when deciding which checks a change needs, writing a failing regression first, verifying a fix, or running e2e, lifecycle, protocol, withdrawal, warp or clock suites. Reports actual commands and results; mocks do not establish client compatibility.
---

Choose checks by the observable behavior changed. Start with deno task check and deno task test. Use
deno task smoke:docker for Docker transport/lifecycle changes and deno task baseline for
compatibility with ordinary clients. Controlled network scenarios require the locally built image.

Time tests must compare protocol timestamps, head roots, and execution hashes, and confirm the head
stays unchanged during a real pause. Test advanceTime/advanceTo across epochs and beyond wall time.
Finalization must be read from Beacon API and agreed with EL finalized, never inferred from slot
count.

Automine tests include concurrent sends, nonce gaps, underpriced pending transactions, and recovery
after a missing nonce arrives. Lifecycle tests include partial startup failure, repeated cleanup,
and protection of a second stand. For exit/withdrawal verify validator status and the actual EL
withdrawal.

Report command, pass/fail, relevant evidence and elapsed time. Mark skipped scenarios explicitly;
mocks do not establish client compatibility. After a fix rerun the original reproduction in a
separate pass.

Run `deno task e2e:withdrawal` for exit and final sweep, `deno task e2e:protocol` for
deposit/activation and explicit-churn consolidation, `deno task test:lifecycle` for
CLI/reset/ownership, and `deno task test:clock` for the native Rust scheduler regression. Preserve
mainnet delays. A zero actual balance need not immediately mean withdrawal_done; check effective
balance and sync committee rewards.
