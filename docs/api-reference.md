# Panda API reference

Generated from `src/api_contract.ts` by `deno task docs:generate`. Do not edit manually.

POST `{method, params}` to `/control`; success returns `{result}`. See [HTTP usage](http-api.md) for errors, operation IDs and lifecycle behavior.

| Command | Parameters | Result | Behavior |
| --- | --- | --- | --- |
| `status` | `[]` | `NetworkStatus` | Read protocol time, execution head and Beacon finality. |
| `lifecycle` | `[]` | `LifecycleState` | Inspect readiness, recovery, checkpoint support and session identity. |
| `resources` | `[]` | `Resources` | Read controller CPU and memory usage. |
| `stop` | `[]` | `Checkpoint` | Stop native clients at a checkpoint while HTTP remains available. |
| `resume` | `[]` | `LifecycleState` | Resume checkpointed clients and replace the session identity. |
| `stepSlot` | `[]` | `TimeState` | Produce the next slot and complete its duties and tail. |
| `advanceSlots` | `[count: number]` | `TimeState` | Advance a non-negative integer count of slots honestly. |
| `advanceEpochs` | `[count: number]` | `TimeState` | Advance a non-negative integer count of 32-slot epochs honestly. |
| `advanceTime` | `[seconds: number] or [seconds: number, options: WarpOptions]` | `TimeState` | Advance by seconds; honest mode is the default. |
| `advanceTo` | `[unixSeconds: number] or [unixSeconds: number, options: WarpOptions]` | `TimeState` | Advance to Unix seconds; the target cannot precede current protocol time. |
| `skipSlots` | `[count: number]` | `TimeState` | Skip slots as downtime without producing a destination block. |
| `setAutomine` | `[enabled: boolean]` | `null` | Enable or disable mining eligible pending transactions. |
| `importValidator` | `[keystore: string, password: string]` | `null` | Import one EIP-2335 keystore JSON string with its password. |
| `exitValidator` | `[pubkey: string]` | `null` | Sign and submit a voluntary exit for a locally managed 48-byte hex public key. |
| `snapshotCreate` | `[operationId: string]` | `SnapshotRef` | Save state at a completed slot tail with an empty transaction pool. Retain the operation UUID. |
| `snapshotRestore` | `[snapshotId: string, operationId: string]` | `SnapshotRestoreResult` | Restore saved state, replace the session and disable automine. Reset external consumers. |
| `snapshotRemove` | `[snapshotId: string, operationId: string]` | `SnapshotRef` | Delete a saved snapshot without changing the active branch. |
| `snapshotList` | `[]` | `SnapshotRef[]` | List saved snapshots belonging to this network owner. |
| `snapshotOperation` | `[operationId: string]` | `SnapshotOperation` | Query a durable outcome; an unknown UUID returns an empty response object. |

`shutdown` accepts no arguments and returns `{id}` without a result envelope. An unknown `snapshotOperation` returns `{}`. `GET /lifecycle` returns lifecycle state directly. `GET /snapshots/{id}/archive` streams a gzip archive with its SHA-256 header.
