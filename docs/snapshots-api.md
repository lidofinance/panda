# Snapshot API reference

Generated from `src/snapshot_types.ts`. Regenerate with `deno task docs:snapshots`; verify with
`deno task docs:snapshots --check`.

[Usage and lifecycle contract](snapshots.md) · [OpenAPI 3.1](snapshots-openapi.json)

POST `/control` with `{"method":"snapshotList","params":[]}`; responses wrap `{"result":...}`. This
reference covers snapshots and lifecycle only. Supply operation UUIDs for safe retries; omission
generates a new ID.

| Method              | Parameters                     | Result                               | Behavior                                                                                             |
| ------------------- | ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `snapshotCreate`    | `[] or [string]` (optional)    | `SnapshotRef`                        | Save and resume at the same time. Supply an operation UUID to recover a lost response.               |
| `snapshotList`      | `[]` (optional)                | `SnapshotRef[]`                      | List this network owner's immutable snapshots.                                                       |
| `snapshotRestore`   | `[string] or [string, string]` | `SnapshotRestoreResult`              | Restore a reusable ID, change session and disable automine. Parameters: snapshot ID, operation UUID. |
| `snapshotRemove`    | `[string] or [string, string]` | `SnapshotRef`                        | Remove only the saved artifact. Parameters: snapshot ID, operation UUID.                             |
| `snapshotOperation` | `[string]`                     | `SnapshotOperationRecord` (optional) | Recover a durable outcome by operation UUID. An unknown operation returns an empty object.           |
| `lifecycle`         | `[]` (optional)                | `SnapshotLifecycle`                  | Inspect readiness and the current session.                                                           |
| `stop`              | `[]` (optional)                | `SnapshotLifecycle`                  | Cleanly stop and preserve the active network at its completed slot.                                  |
| `resume`            | `[]` (optional)                | `SnapshotLifecycle`                  | Resume the preserved active network and change session.                                              |

An unknown `snapshotOperation` returns `{}`. Errors use `SnapshotControlError`: inspect lifecycle
and any recorded operation after HTTP 500; HTTP 503 indicates closed or unready ingress. Foreign
Host/Origin requests receive 403 with plain text.

GET `/lifecycle` returns `SnapshotLifecycle` directly. GET `/snapshots/{id}/archive` returns gzip
bytes with `X-Panda-SHA256` and `Content-Length`. Import via startup `--snapshot` or
`PANDA_SNAPSHOT`, not an HTTP upload.

Field types, required properties and descriptions are defined in the linked OpenAPI schemas.
