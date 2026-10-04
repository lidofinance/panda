import { join } from "node:path";
import { statfs } from "node:fs/promises";
import type { Config } from "./config.ts";
import type { Infrastructure } from "./docker.ts";
import { type Bake, type BakedImage, canonical, type ProfileName, sha256 } from "./profiles.ts";
import {
  type ActiveGeneration,
  type Checkpoint,
  durableJson,
  fileInventory,
  StateLock,
  StateStore,
  treeMetadata,
} from "./storage.ts";

export interface SnapshotRef {
  id: string;
  createdAt: string;
  profile: ProfileName;
  bakeKey: string;
  nowMs: number;
  headSlot: number;
  headBlockRoot: string;
}

export interface SnapshotManifest {
  schema: 1;
  owner: string;
  snapshot: SnapshotRef;
  config: Config;
  checkpoint: Checkpoint;
  images: Record<"el" | "cl" | "genesis", Pick<BakedImage, "id" | "platform">>;
  files: Awaited<ReturnType<typeof fileInventory>>;
  metadata: Awaited<ReturnType<typeof treeMetadata>>;
  checksum: string;
}

interface RemovalRecord {
  schema: 1;
  owner: string;
  snapshot: SnapshotRef;
  checksum: string;
}

function snapshotId(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) {
    throw new Error("Invalid snapshot ID");
  }
  return value;
}

async function syncDirectory(path: string): Promise<void> {
  using directory = await Deno.open(path, { read: true });
  await directory.sync();
}

async function safeDirectory(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) throw new Error("Unsafe snapshot directory");
}

async function readJson(path: string): Promise<unknown> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) throw new Error("Unsafe snapshot manifest");
  return JSON.parse(await Deno.readTextFile(path));
}

function imageIdentity(bake: Bake): SnapshotManifest["images"] {
  return Object.fromEntries(["el", "cl", "genesis"].map((role) => {
    const image = bake.images[role as keyof Bake["images"]];
    return [role, { id: image.id, platform: image.platform }];
  })) as SnapshotManifest["images"];
}

/** A private immutable artifact; controller lifecycle owns stopping and resuming the source. */
export class SnapshotStore {
  constructor(readonly store: StateStore, readonly infra: Infrastructure) {
    if (store.id !== infra.id) throw new Error("Snapshot infrastructure ownership mismatch");
  }

  private async path(id: string): Promise<string> {
    snapshotId(id);
    return join(await this.store.snapshotsDirectory(), id);
  }

  private async removed(id: string): Promise<RemovalRecord | undefined> {
    snapshotId(id);
    let value: RemovalRecord;
    try {
      value = await readJson(
        join(await this.store.snapshotsDirectory(), `.removed-${id}.json`),
      ) as RemovalRecord;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    const { checksum, ...body } = value;
    if (
      value.schema !== 1 || value.owner !== this.store.id || value.snapshot?.id !== id ||
      checksum !== await sha256(canonical(body))
    ) throw new Error("Invalid snapshot removal record");
    return value;
  }

  private async metadata(id: string, requireData = true): Promise<SnapshotManifest> {
    const path = await this.path(id);
    if (await this.removed(id)) throw new Deno.errors.NotFound("Snapshot was removed");
    await safeDirectory(path);
    const value = await readJson(join(path, "manifest.json")) as SnapshotManifest;
    if (
      value?.schema !== 1 || value.owner !== this.store.id || value.config?.id !== this.store.id ||
      value.snapshot?.id !== id || value.checkpoint?.abi !== 1
    ) throw new Error("Snapshot ownership/schema/checkpoint mismatch");
    const { checksum, ...body } = value;
    if (checksum !== await sha256(canonical(body))) {
      throw new Error("Snapshot manifest checksum mismatch");
    }
    if (requireData) await safeDirectory(join(path, "data"));
    return value;
  }

  async list(): Promise<SnapshotRef[]> {
    const directory = await this.store.snapshotsDirectory();
    const result: SnapshotRef[] = [];
    for await (const entry of Deno.readDir(directory)) {
      // An interrupted publication is never advertised as a restorable snapshot.
      if (
        [".pending-", ".removed-", ".removing-"].some((prefix) => entry.name.startsWith(prefix))
      ) continue;
      try {
        const manifest = await this.metadata(entry.name);
        result.push(manifest.snapshot);
      } catch (error) {
        // Removal may hide or rename a listed artifact before its manifest is read.
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return result.sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  }

  /** The durable tombstone permits retry even after recursive unlink removed the manifest. */
  async remove(
    id: string,
    removing: (snapshot: SnapshotRef) => Promise<void> = () => Promise.resolve(),
  ): Promise<SnapshotRef> {
    const final = await this.path(id);
    const parent = await this.store.snapshotsDirectory();
    const lock = await StateLock.acquire(join(this.store.root, "snapshots.lock"));
    try {
      const previous = await this.removed(id);
      // Corrupt database files need not be readable to delete an explicitly selected owned archive.
      const snapshot = previous?.snapshot ?? (await this.metadata(id, false)).snapshot;
      await removing(snapshot);
      if (!previous) {
        const body = { schema: 1 as const, owner: this.store.id, snapshot };
        await durableJson(join(parent, `.removed-${id}.json`), {
          ...body,
          checksum: await sha256(canonical(body)),
        });
      }
      const tombstone = join(parent, `.removing-${id}`);
      try {
        await safeDirectory(final);
        try {
          await Deno.lstat(tombstone);
          throw new Error("Snapshot removal destination already exists");
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await Deno.rename(final, tombstone);
        await syncDirectory(parent);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      try {
        await safeDirectory(tombstone);
        await Deno.remove(tombstone, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await syncDirectory(parent);
      // Keep the tiny tombstone: retired IDs cannot be reused and lost deletion ACKs are recoverable.
      return snapshot;
    } finally {
      lock.release();
    }
  }

  /** Full readback is mandatory before touching a working network during restore. */
  async read(id: string, bake?: Bake, config?: Config): Promise<SnapshotManifest> {
    const value = await this.metadata(id);
    if (
      bake && (bake.recipe.checkpointAbi !== 1 || value.snapshot.bakeKey !== bake.key ||
        value.snapshot.profile !== bake.profile ||
        canonical(value.images) !== canonical(imageIdentity(bake)))
    ) throw new Error("Snapshot requires its exact checkpoint-capable bake and image platform");
    if (config && canonical(config) !== canonical(value.config)) {
      throw new Error("Snapshot configuration or schedule mismatch");
    }
    const files = await fileInventory(join(await this.path(id), "data"));
    const metadata = await treeMetadata(join(await this.path(id), "data"));
    if (
      canonical(files) !== canonical(value.files) ||
      canonical(metadata) !== canonical(value.metadata)
    ) {
      throw new Error("Snapshot file integrity failure");
    }
    return value;
  }

  /** Prepare and verify a disposable copy before stopping the currently running network. */
  async prepare(
    id: string,
    bake: Bake,
    config: Config,
    allocated: (candidate: ActiveGeneration) => Promise<void>,
  ): Promise<ActiveGeneration> {
    await this.path(id);
    const lock = await StateLock.acquire(join(this.store.root, "snapshots.lock"));
    try {
      const manifest = await this.read(id, bake, config);
      const bytes = Object.values(manifest.files).reduce((sum, file) => sum + file.size, 0);
      const disk = await statfs(this.store.root);
      // Reserve copy metadata and some headroom before the destructive half of restore.
      if (disk.bavail * disk.bsize < bytes + Math.max(16 * 1024 * 1024, bytes * 0.05)) {
        throw new Error("Insufficient free space to prepare snapshot restore");
      }
      const candidate = await this.store.allocate(manifest.config, manifest.snapshot.bakeKey);
      // The durable operation must know the destination even if copying never completes.
      await allocated(candidate);
      await this.infra.copySnapshot(this.store, id, candidate);
      const files = await fileInventory(this.store.generationPath(candidate.generation));
      const metadata = await treeMetadata(this.store.generationPath(candidate.generation));
      delete files["owner.json"];
      delete metadata["owner.json"];
      if (
        canonical(files) !== canonical(manifest.files) ||
        canonical(metadata) !== canonical(manifest.metadata)
      ) {
        throw new Error("Prepared snapshot copy integrity failure");
      }
      // Recheck the immutable artifact after copying, including its manifest.
      if (canonical(await this.read(id, bake, config)) !== canonical(manifest)) {
        throw new Error("Snapshot changed during restore preparation");
      }
      return { ...candidate, phase: "stopped", checkpoint: manifest.checkpoint };
    } finally {
      lock.release();
    }
  }

  async capture(bake: Bake, id: string = crypto.randomUUID()): Promise<SnapshotRef> {
    const final = await this.path(id);
    const lock = await StateLock.acquire(join(this.store.root, "snapshots.lock"));
    try {
      if (await this.removed(id)) {
        throw new Error("Snapshot was removed; immutable IDs cannot be reused");
      }
      try {
        await Deno.lstat(final);
        throw new Error("Snapshot already exists; immutable artifacts cannot be overwritten");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      const source = await this.store.resumable();
      if (
        source.config.mode !== "controlled" || source.config.profile !== bake.profile ||
        source.bakeKey !== bake.key || bake.recipe.checkpointAbi !== 1
      ) throw new Error("Snapshot requires the active checkpoint-capable bake");

      // The existing copy helper verifies stopped ownership, exact Docker labels, all paths,
      // byte integrity and permissions. It never publishes its destination as active.
      const destination = await this.store.allocate(source.config, source.bakeKey);
      await this.infra.copyGeneration(this.store, source, destination);
      const copied = this.store.generationPath(destination.generation);
      for await (const entry of Deno.readDir(copied)) {
        if (!["owner.json", "el", "bn", "shared", "admission.json"].includes(entry.name)) {
          throw new Error(`Unexpected transient generation entry: ${entry.name}`);
        }
      }
      const checkpoint = source.checkpoint!;
      const databases = {
        el: await fileInventory(join(copied, "el")),
        bn: await fileInventory(join(copied, "bn")),
      };
      const shared: Record<string, unknown> = {};
      for (const name of ["metadata", "jwt", "validator-keys"]) {
        shared[name] = await fileInventory(join(copied, "shared", name));
      }
      if (
        canonical(databases) !== canonical(checkpoint.databaseFiles) ||
        canonical(shared) !== canonical(checkpoint.sharedFiles)
      ) throw new Error("Snapshot data differs from the verified stopped checkpoint");
      const admission = await Deno.lstat(join(copied, "admission.json"));
      if (!admission.isFile || admission.isSymlink) {
        throw new Error("Missing snapshot admission ledger");
      }

      const parent = await this.store.snapshotsDirectory();
      const temporary = join(parent, `.pending-${id}`);
      await Deno.mkdir(temporary, { mode: 0o700 });
      await syncDirectory(parent);
      await Deno.rename(copied, join(temporary, "data"));
      await syncDirectory(join(this.store.root, "generations"));
      // Ownership is in the artifact manifest. Never archive the source generation's handles.
      await Deno.remove(join(temporary, "data", "owner.json"));
      await syncDirectory(join(temporary, "data"));
      const snapshot: SnapshotRef = {
        id,
        createdAt: new Date().toISOString(),
        profile: source.config.profile,
        bakeKey: source.bakeKey,
        nowMs: checkpoint.nowMs,
        headSlot: checkpoint.headSlot,
        headBlockRoot: checkpoint.headBlockRoot,
      };
      const body = {
        schema: 1 as const,
        owner: this.store.id,
        snapshot,
        config: source.config,
        checkpoint,
        images: imageIdentity(bake),
        files: await fileInventory(join(temporary, "data")),
        metadata: await treeMetadata(join(temporary, "data")),
      };
      const manifest: SnapshotManifest = { ...body, checksum: await sha256(canonical(body)) };
      await durableJson(join(temporary, "manifest.json"), manifest);
      if (canonical(await readJson(join(temporary, "manifest.json"))) !== canonical(manifest)) {
        throw new Error("Snapshot manifest readback mismatch");
      }
      if (
        canonical(await fileInventory(join(temporary, "data"))) !== canonical(manifest.files) ||
        canonical(await treeMetadata(join(temporary, "data"))) !== canonical(manifest.metadata)
      ) {
        throw new Error("Snapshot data readback integrity failure");
      }
      await Deno.rename(temporary, final);
      await syncDirectory(parent);
      return snapshot;
    } finally {
      lock.release();
    }
  }
}
