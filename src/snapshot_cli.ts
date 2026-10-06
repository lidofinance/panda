import { argumentsFor } from "./arguments.ts";
import { Devnet } from "./api.ts";
import { operationId } from "./snapshot_types.ts";

export function snapshotCommand(args: string[]) {
  const { positional, flags } = argumentsFor(args, ["operation"]);
  const [action, id, path] = positional;
  if (!["create", "list", "restore", "remove", "export", "operation"].includes(action)) {
    throw new Error(
      "Usage: panda snapshot create|list|restore <id>|remove <id>|export <id> <path>|operation <id>",
    );
  }
  const count = action === "export" ? 3 : action === "create" || action === "list" ? 1 : 2;
  if (positional.length !== count) throw new Error(`Invalid snapshot ${action} arguments`);
  if (flags.operation && !["create", "restore", "remove"].includes(action)) {
    throw new Error(`Snapshot ${action} does not accept --operation`);
  }
  if (id) operationId(id);
  if (flags.operation) operationId(flags.operation);
  return { action, id, path, operation: flags.operation };
}

export async function runSnapshotCommand(url: string, args: string[]): Promise<unknown> {
  const { action, id, path, operation } = snapshotCommand(args);
  const net = new Devnet(url);
  switch (action) {
    case "create":
      return await net.createSnapshot(operation);
    case "list":
      return await net.listSnapshots();
    case "restore":
      return await net.restoreSnapshot(id, operation);
    case "remove":
      return await net.removeSnapshot(id, operation);
    case "export":
      return await net.exportSnapshot(id, path);
    case "operation":
      return await net.snapshotOperation(id);
  }
}
