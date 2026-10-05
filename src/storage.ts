import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "./config.ts";

export type StoredPhase = "starting" | "running" | "stopping" | "stopped" | "faulted";
import type { Checkpoint } from "./api_contract.ts";
export type { Checkpoint } from "./api_contract.ts";
export interface ActiveGeneration {
  schema: 1;
  id: string;
  generation: string;
  config: Config;
  bakeKey: string;
  phase: StoredPhase;
  checkpoint?: Checkpoint;
  error?: string;
}

/** Persist intent before exposing its result; rename alone is not a durable commit. */
export async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    using file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
    for (let offset = 0; offset < bytes.length;) offset += await file.write(bytes.subarray(offset));
    await file.sync();
    await Deno.rename(temporary, path);
    using parent = await Deno.open(dirname(path), { read: true });
    await parent.sync();
  } finally {
    await Deno.remove(temporary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

export function stateDirectory(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Invalid devnet id");
  return resolve(Deno.env.get("PANDA_DATA_DIR") ?? ".panda", id);
}

/** Keep the inode in place: unlinking a PID file permits two stale-lock reclaimers to win. */
export class StateLock {
  private constructor(private file: Deno.FsFile) {}
  static async acquire(path: string): Promise<StateLock> {
    try {
      const info = await Deno.lstat(path);
      if (!info.isFile || info.isSymlink) throw new Error("Unsafe ownership lock");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const file = await Deno.open(path, { create: true, read: true, write: true, mode: 0o600 });
    try {
      const [actual, named] = await Promise.all([file.stat(), Deno.lstat(path)]);
      if (named.isSymlink || actual.ino !== named.ino || actual.dev !== named.dev) {
        throw new Error("Ownership lock changed while opening");
      }
      if (!await file.tryLock(true)) {
        throw new Error("Devnet is owned by live process; use its controller");
      }
      await file.truncate(0);
      await file.write(new TextEncoder().encode(String(Deno.pid)));
      return new StateLock(file);
    } catch (error) {
      file.close();
      throw error;
    }
  }
  release(): void {
    this.file.close();
  }
}

async function directory(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) throw new Error(`Unsafe state directory: ${path}`);
}

/** Publish each newly created directory name before any durable file can refer to it. */
async function createDirectory(path: string, existing = false): Promise<void> {
  const parent = dirname(path);
  try {
    await Deno.stat(parent);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await createDirectory(parent, true);
  }
  await Deno.mkdir(path, { recursive: existing, mode: 0o700 });
  await directory(path);
  using owner = await Deno.open(parent, { read: true });
  await owner.sync();
}

/** Hash the whole supported tree, including filenames, and reject links at every depth. */
export async function fileInventory(
  root: string,
): Promise<Record<string, { hash: string; size: number }>> {
  const result: Record<string, { hash: string; size: number }> = {};
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const info = await Deno.lstat(path);
    if (info.isSymlink) throw new Error(`Unsafe link in persisted state: ${relative}`);
    if (info.isDirectory) {
      const entries = [];
      for await (const entry of Deno.readDir(path)) entries.push(entry.name);
      for (const name of entries.sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile) {
      // EL/BN table files can exceed controller memory. Hash a bounded chunk at a time.
      using file = await Deno.open(path, { read: true });
      const digest = createHash("sha256");
      const chunk = new Uint8Array(1024 * 1024);
      let size = 0;
      for (;;) {
        const length = await file.read(chunk);
        if (length === null) break;
        digest.update(chunk.subarray(0, length));
        size += length;
      }
      if (size !== info.size) {
        throw new Error(`Persisted file changed during inventory: ${relative}`);
      }
      result[relative] = { hash: digest.digest("hex"), size };
    } else throw new Error(`Unsupported persisted state entry: ${relative}`);
  }
  await visit("");
  return result;
}

/** Bind access rights and empty directories too; timestamps change during ordinary reads. */
export async function treeMetadata(root: string): Promise<
  Record<string, {
    type: "file" | "directory";
    mode: number | null;
    uid: number | null;
    gid: number | null;
  }>
> {
  const result: Awaited<ReturnType<typeof treeMetadata>> = {};
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const info = await Deno.lstat(path);
    if (info.isSymlink || (!info.isDirectory && !info.isFile)) {
      throw new Error(`Unsupported entry in persisted state: ${relative}`);
    }
    result[relative || "."] = {
      type: info.isDirectory ? "directory" : "file",
      mode: info.mode === null ? null : info.mode & 0o7777,
      uid: info.uid,
      gid: info.gid,
    };
    if (info.isDirectory) {
      const names = [];
      for await (const entry of Deno.readDir(path)) names.push(entry.name);
      for (const name of names.sort()) await visit(relative ? `${relative}/${name}` : name);
    }
  }
  await visit("");
  return result;
}

/** A killed client can leave Unix sockets; they are disposable, never archive contents. */
async function assertDiscardableTree(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (info.isSymlink || (!info.isDirectory && !info.isFile && !info.isSocket)) {
    throw new Error(`Unsupported entry in discarded generation: ${path}`);
  }
  if (info.isDirectory) {
    for await (const entry of Deno.readDir(path)) {
      await assertDiscardableTree(join(path, entry.name));
    }
  }
}

/** One owner, one active generation. Snapshot storage is deliberately outside destroy(). */
export class StateStore {
  readonly root: string;
  constructor(readonly id: string) {
    this.root = stateDirectory(id);
  }
  async initialize(): Promise<void> {
    await createDirectory(this.root, true);
    const owner = join(this.root, "owner.json");
    try {
      await this.validateOwner();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      for (const name of ["active.json", "generations", "snapshots"]) {
        try {
          await Deno.lstat(join(this.root, name));
        } catch (missing) {
          if (missing instanceof Deno.errors.NotFound) continue;
          throw missing;
        }
        throw new Error("Existing durable data has no ownership marker");
      }
      await durableJson(owner, { schema: 1, id: this.id });
    }
    for (const name of ["generations", "snapshots"]) {
      await createDirectory(join(this.root, name), true);
    }
  }
  private async validateOwner(): Promise<void> {
    const owner = JSON.parse(await this.readFile(join(this.root, "owner.json")));
    if (owner.schema !== 1 || owner.id !== this.id) {
      throw new Error("State directory ownership/schema mismatch");
    }
  }
  private async readFile(path: string): Promise<string> {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) throw new Error(`Unsafe state file: ${path}`);
    return await Deno.readTextFile(path);
  }
  generationPath(generation: string): string {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(generation)) {
      throw new Error("Invalid generation ID");
    }
    return join(this.root, "generations", generation);
  }
  async snapshotsDirectory(): Promise<string> {
    await directory(this.root);
    await this.validateOwner();
    const path = join(this.root, "snapshots");
    await directory(path);
    return path;
  }
  async validate(value: ActiveGeneration): Promise<string> {
    if (value.schema !== 1 || value.id !== this.id || value.config?.id !== this.id) {
      throw new Error("Generation ownership/schema mismatch");
    }
    await directory(this.root);
    await this.validateOwner();
    await directory(join(this.root, "generations"));
    const path = this.generationPath(value.generation);
    await directory(path);
    const owner = JSON.parse(await this.readFile(join(path, "owner.json")));
    if (owner.id !== this.id || owner.generation !== value.generation || owner.schema !== 1) {
      throw new Error("Generation ownership mismatch");
    }
    for (const name of ["el", "bn", "shared"]) await directory(join(path, name));
    return path;
  }
  async active(): Promise<ActiveGeneration | undefined> {
    let text: string;
    try {
      text = await this.readFile(join(this.root, "active.json"));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    const value: ActiveGeneration = JSON.parse(text);
    await this.validate(value);
    if (!["starting", "running", "stopping", "stopped", "faulted"].includes(value.phase)) {
      throw new Error("Invalid stored lifecycle phase");
    }
    return value;
  }
  /** An observed rename is not enough to retire the old branch after a lost commit ACK. */
  async syncAuthority(): Promise<void> {
    await directory(this.root);
    await this.validateOwner();
    if (await this.active()) {
      using pointer = await Deno.open(join(this.root, "active.json"), { read: true });
      await pointer.sync();
    }
    // This also makes an absent pointer durable after explicit down removed it.
    using root = await Deno.open(this.root, { read: true });
    await root.sync();
  }
  async create(config: Config, bakeKey: string): Promise<ActiveGeneration> {
    await this.initialize();
    if (await this.active()) {
      throw new Error("Active generation exists; resume it or use down/reset");
    }
    const value = await this.allocate(config, bakeKey);
    await this.write(value);
    return value;
  }
  /** Allocate an owned, inactive destination. Only write() publishes it as active. */
  async allocate(
    config: Config,
    bakeKey: string,
    allocating: (value: ActiveGeneration) => Promise<void> = () => Promise.resolve(),
  ): Promise<ActiveGeneration> {
    if (config.id !== this.id) throw new Error("Generation configuration ownership mismatch");
    await this.initialize();
    const generation = crypto.randomUUID();
    const value: ActiveGeneration = {
      schema: 1,
      id: this.id,
      generation,
      config,
      bakeKey,
      phase: "starting",
    };
    // Persist the destination in the operation before even an incomplete directory can exist.
    await allocating(value);
    const path = this.generationPath(generation);
    await createDirectory(path);
    for (const name of ["el", "bn", "shared"]) await createDirectory(join(path, name));
    await durableJson(join(path, "owner.json"), { schema: 1, id: this.id, generation });
    return value;
  }
  async write(value: ActiveGeneration): Promise<void> {
    await this.validate(value);
    await durableJson(join(this.root, "active.json"), value);
  }
  async resumable(): Promise<ActiveGeneration> {
    const value = await this.active();
    if (!value) throw new Error("No preserved active generation");
    return await this.validateCheckpoint(value);
  }
  async validateCheckpoint(value: ActiveGeneration): Promise<ActiveGeneration> {
    await this.validate(value);
    if (value.phase !== "stopped" || value.checkpoint?.abi !== 1) {
      throw new Error(
        "Active generation is unclean or lacks a verified checkpoint; use down/reset",
      );
    }
    const c = value.checkpoint;
    for (const key of ["nowMs", "headSlot", "forkChoiceSlot"] as const) {
      if (!Number.isSafeInteger(c[key]) || c[key] < 0) throw new Error(`Invalid checkpoint ${key}`);
    }
    for (const key of ["headBlockRoot", "headStateRoot", "checkpointHash"] as const) {
      if (!/^0x[a-f0-9]{64}$/.test(c[key])) throw new Error(`Invalid checkpoint ${key}`);
    }
    const elapsed = c.nowMs - value.config.genesisTime * 1000;
    if (elapsed < 0 || elapsed % 12_000 !== 11_500 || Math.floor(elapsed / 12_000) !== c.headSlot) {
      throw new Error("Checkpoint is not a completed slot tail");
    }
    return value;
  }
  async destroy(value: ActiveGeneration): Promise<void> {
    const path = await this.validate(value);
    const active = await this.active();
    if (active?.generation !== value.generation) throw new Error("Active generation changed");
    // Remove the pointer first. An interrupted deletion cannot later become a resumable network.
    await Deno.remove(join(this.root, "active.json"));
    using root = await Deno.open(this.root, { read: true });
    await root.sync();
    await Deno.remove(path, { recursive: true });
  }

  /** Caller holds network ownership and a durable journal reference to this inactive directory. */
  async discardInactive(
    generation: string,
    allocated: boolean,
    assertUnused: () => Promise<void>,
  ): Promise<void> {
    await this.validateOwner();
    await directory(this.root);
    const parent = join(this.root, "generations");
    await directory(parent);
    const path = this.generationPath(generation);
    if ((await this.active())?.generation === generation) {
      throw new Error("Cannot discard the active generation");
    }
    const trash = join(parent, `.discarded-${generation}`);
    let exists = false;
    try {
      await directory(path);
      exists = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    let discarded = false;
    try {
      await directory(trash);
      discarded = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (exists || discarded) await assertUnused();
    if (exists) {
      try {
        const owner = JSON.parse(await this.readFile(join(path, "owner.json")));
        if (owner.schema !== 1 || owner.id !== this.id || owner.generation !== generation) {
          throw new Error("Discarded generation ownership mismatch");
        }
      } catch (error) {
        // A journaled allocation may have died before writing its ownership marker.
        if (!allocated || !(error instanceof Deno.errors.NotFound)) throw error;
      }
      await assertDiscardableTree(path);
      try {
        await Deno.lstat(trash);
        throw new Error("Discarded generation destination already exists");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await Deno.rename(path, trash);
      using parentDirectory = await Deno.open(parent, { read: true });
      await parentDirectory.sync();
    }
    try {
      // The durable journal still authorizes this path after partial unlink removed owner.json.
      await directory(trash);
      await assertDiscardableTree(trash);
      await Deno.remove(trash, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    using parentDirectory = await Deno.open(parent, { read: true });
    await parentDirectory.sync();
  }
}
