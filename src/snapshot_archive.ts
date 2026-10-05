import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configuration } from "./config.ts";
import { defaultTimeoutMs } from "./http.ts";
import { type Bake, bakeTag, bakeTags, canonical, profileName, readBake } from "./profiles.ts";
import { validateCheckpoint } from "./storage.ts";
import type { SnapshotManifest } from "./snapshots.ts";

const magic = new TextEncoder().encode("PANDA_SNAPSHOT_V2\n");
const headerLimit = 16 * 1024 * 1024;
export const snapshotByteLimit = 8 * 1024 ** 3;
export interface SnapshotImportOptions {
  /** SHA-256 of the compressed file (recommended for CI). */
  sha256?: string;
  /** Equivalent installed bake tag; its key, client images and platform must match exactly. */
  bake?: string;
  /** Limit for both downloaded and uncompressed bytes. Defaults to 8 GiB. */
  maxBytes?: number;
  signal?: AbortSignal;
}
export interface SnapshotExportResult {
  path: string;
  sha256: string;
  bytes: number;
}
type PortableManifest = Omit<SnapshotManifest, "owner" | "checksum" | "metadata" | "config"> & {
  format: "panda-snapshot";
  config: Omit<SnapshotManifest["config"], "id">;
  metadata: Record<string, { type: "file" | "directory"; mode: number }>;
};

export function isSnapshotId(source: string): boolean {
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(source);
}
export function transferSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(defaultTimeoutMs()),
    ...(signal ? [signal] : []),
  ]);
}
function byteLimit(value = snapshotByteLimit): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid snapshot byte limit");
  return value;
}
export async function syncDirectory(path: string): Promise<void> {
  using file = await Deno.open(path, { read: true });
  await file.sync();
}
async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  for (let at = 0; at < bytes.length;) at += await file.write(bytes.subarray(at));
}

/** Stream to a new file; the destination is never truncated or silently replaced. */
export async function saveSnapshotStream(
  stream: ReadableStream<Uint8Array>,
  destination: string,
  options: SnapshotImportOptions = {},
): Promise<SnapshotExportResult> {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const signal = transferSignal(options.signal);
    const limit = byteLimit(options.maxBytes);
    if (options.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.sha256)) {
      throw new Error("Expected snapshot SHA-256 must contain 64 lowercase hex digits");
    }
    using file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    await stream.pipeTo(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          bytes += chunk.length;
          if (bytes > limit) throw new Error("Snapshot exceeds byte limit");
          hash.update(chunk);
          await writeAll(file, chunk);
        },
      }),
      { signal },
    );
    const sha256 = hash.digest("hex");
    if (options.sha256 && options.sha256 !== sha256) throw new Error("Snapshot SHA-256 mismatch");
    await file.sync();
    // Hard-link publication is atomic and fails if the caller's destination already exists.
    await Deno.link(temporary, destination);
    await syncDirectory(dirname(destination));
    return { path: destination, sha256, bytes };
  } finally {
    if (!stream.locked) await stream.cancel().catch(() => {});
    await Deno.remove(temporary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Snapshot URL must use HTTPS without credentials or a fragment");
  }
  return url;
}
export async function snapshotSource(
  source: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  signal.throwIfAborted();
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    let url = httpsUrl(source);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Snapshot redirect has no location");
        url = httpsUrl(new URL(location, url).href);
        continue;
      }
      if (
        !response.ok || !response.body ||
        /text\/html/i.test(response.headers.get("content-type") ?? "")
      ) {
        await response.body?.cancel();
        throw new Error(
          `Snapshot download: HTTP ${response.status}; use a raw file or Release asset URL`,
        );
      }
      return response.body;
    }
    throw new Error("Too many snapshot redirects");
  }
  const info = await Deno.lstat(source);
  if (!info.isFile || info.isSymlink) throw new Error("Snapshot source must be a regular file");
  const file = await Deno.open(source, { read: true });
  const actual = await file.stat();
  if (actual.ino !== info.ino || actual.dev !== info.dev) {
    file.close();
    throw new Error("Snapshot source changed while opening");
  }
  return file.readable;
}

/** Only file bytes and portable metadata leave the owning controller. */
export function encodeSnapshot(
  manifest: SnapshotManifest,
  directory: string,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const { id: _id, ...config } = manifest.config;
  const portable: PortableManifest = {
    format: "panda-snapshot",
    schema: 2,
    snapshot: manifest.snapshot,
    config,
    checkpoint: manifest.checkpoint,
    images: manifest.images,
    files: manifest.files,
    metadata: Object.fromEntries(
      Object.entries(manifest.metadata).map(([name, info]) => [
        name,
        {
          type: info.type,
          mode: (info.mode ?? (info.type === "directory" ? 0o700 : 0o600)) & 0o777,
        },
      ]),
    ),
  };
  async function* chunks() {
    signal.throwIfAborted();
    const header = new TextEncoder().encode(canonical(portable));
    if (header.length > headerLimit) throw new Error("Snapshot header exceeds limit");
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, header.length);
    yield magic;
    yield length;
    yield header;
    for (const name of Object.keys(manifest.files).sort()) {
      using file = await Deno.open(join(directory, name), { read: true });
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of file.readable) {
        signal.throwIfAborted();
        size += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
      if (size !== manifest.files[name].size || hash.digest("hex") !== manifest.files[name].hash) {
        throw new Error("Snapshot changed during export");
      }
    }
  }
  return ReadableStream.from(chunks()).pipeThrough(new CompressionStream("gzip"));
}

class ArchiveReader {
  private chunk = new Uint8Array();
  private offset = 0;
  private total = 0;
  constructor(
    readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    readonly signal: AbortSignal,
    readonly limit: number,
  ) {}
  async take(length: number): Promise<Uint8Array> {
    this.signal.throwIfAborted();
    if (this.offset === this.chunk.length) {
      const next = await this.reader.read();
      if (next.done) return new Uint8Array();
      this.chunk = new Uint8Array(next.value);
      this.offset = 0;
      this.total += this.chunk.length;
      if (this.total > this.limit) throw new Error("Uncompressed snapshot exceeds byte limit");
    }
    const part = this.chunk.subarray(this.offset, this.offset + length);
    this.offset += part.length;
    return part;
  }
  async exact(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    for (let at = 0; at < length;) {
      const chunk = await this.take(length - at);
      if (!chunk.length) throw new Error("Truncated snapshot archive");
      result.set(chunk, at);
      at += chunk.length;
    }
    return result;
  }
}

function validPath(name: string): void {
  const controlCharacter = [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  if (
    name !== "." && (name.length > 1024 || name.includes("\\") || controlCharacter ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      !["el", "bn", "shared"].includes(name.split("/")[0]))
  ) throw new Error("Unsafe snapshot path");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateHeader(value: PortableManifest, limit: number): void {
  if (
    !object(value) || value.format !== "panda-snapshot" || value.schema !== 2 ||
    !object(value.config) || value.config.mode !== "controlled" ||
    !object(value.snapshot) || !isSnapshotId(value.snapshot.id) ||
    !object(value.checkpoint) || value.checkpoint.schema !== 2 ||
    !object(value.files) || !object(value.metadata) || !object(value.images)
  ) throw new Error("Invalid snapshot archive header");
  const config = configuration({ ...value.config, id: "import" });
  const configKeys = [
    "profile",
    "bake",
    "mode",
    "genesisTime",
    "validators",
    "chainId",
    "churnLimitQuotient",
    "consolidationChurnLimitQuotient",
  ];
  if (canonical(Object.keys(value.config).sort()) !== canonical(configKeys.sort())) {
    throw new Error("Unknown or missing snapshot configuration fields");
  }
  const { id: _id, ...expected } = config;
  if (canonical(expected) !== canonical(value.config)) {
    throw new Error("Invalid snapshot configuration");
  }
  profileName(config.profile);
  bakeTag(config.bake);
  if (
    value.snapshot.profile !== config.profile ||
    !/^[a-f0-9]{64}$/.test(value.snapshot.bakeKey) ||
    !Number.isFinite(Date.parse(value.snapshot.createdAt)) ||
    value.snapshot.nowMs !== value.checkpoint.nowMs ||
    value.snapshot.headSlot !== value.checkpoint.headSlot ||
    value.snapshot.headBlockRoot !== value.checkpoint.headBlockRoot
  ) throw new Error("Invalid snapshot checkpoint anchors");
  validateCheckpoint(value.checkpoint, config);
  if (Object.keys(value.metadata).length > 100_000) throw new Error("Too many snapshot entries");
  let bytes = 0;
  for (const [name, info] of Object.entries(value.metadata)) {
    validPath(name);
    if (
      !object(info) || !["file", "directory"].includes(info.type) ||
      !Number.isInteger(info.mode) || info.mode < 0 || info.mode > 0o777
    ) {
      throw new Error("Invalid snapshot entry type or permissions");
    }
    if (name !== "." && value.metadata[dirname(name)]?.type !== "directory") {
      throw new Error("Missing snapshot parent directory");
    }
    if (info.type === "file" && !value.files[name]) {
      throw new Error("Missing snapshot file inventory");
    }
  }
  for (
    const name of [
      ".",
      "el",
      "bn",
      "shared",
      "shared/metadata",
      "shared/jwt",
      "shared/validator-keys",
    ]
  ) {
    if (value.metadata[name]?.type !== "directory") {
      throw new Error("Missing snapshot data directory");
    }
  }
  for (const [name, info] of Object.entries(value.files)) {
    validPath(name);
    if (
      !object(info) || !/^[a-f0-9]{64}$/.test(info.hash) ||
      !Number.isSafeInteger(info.size) || info.size < 0 || value.metadata[name]?.type !== "file"
    ) {
      throw new Error("Invalid snapshot file inventory");
    }
    bytes += info.size;
    if (bytes > limit) throw new Error("Uncompressed snapshot exceeds byte limit");
  }
  const inventory = (prefix: string) =>
    Object.fromEntries(
      Object.entries(value.files).filter(([name]) => name.startsWith(`${prefix}/`))
        .map(([name, info]) => [name.slice(prefix.length + 1), info]),
    );
  if (
    canonical({ el: inventory("el"), bn: inventory("bn") }) !==
      canonical(value.checkpoint.databaseFiles) ||
    canonical(
        Object.fromEntries(
          ["metadata", "jwt", "validator-keys"].map((name) => [name, inventory(`shared/${name}`)]),
        ),
      ) !== canonical(value.checkpoint.sharedFiles)
  ) throw new Error("Snapshot inventory differs from the saved state");
}
async function compatibleBake(header: PortableManifest, tag?: string): Promise<Bake> {
  const matches = (bake: Bake) =>
    bake.recipe.ptcReadiness === true &&
    bake.key === header.snapshot.bakeKey &&
    canonical(header.images) ===
      canonical(Object.fromEntries(["el", "cl", "genesis"].map((role) => {
        const image = bake.images[role as keyof Bake["images"]];
        return [role, { id: image.id, platform: image.platform }];
      })));
  const tags = tag
    ? [bakeTag(tag)]
    : [header.config.bake, ...await bakeTags(header.config.profile)];
  for (const candidate of new Set(tags)) {
    let bake: Bake;
    try {
      bake = await readBake(header.config.profile, candidate);
    } catch (error) {
      if (tag) throw error;
      else continue;
    }
    if (matches(bake)) return bake;
  }
  throw new Error(
    "Snapshot requires an installed exact replay-capable bake and image platform",
  );
}

/** Decode into a newly allocated private directory. Nothing here can activate a generation. */
export async function decodeSnapshot(
  path: string,
  directory: string,
  options: SnapshotImportOptions,
): Promise<{ header: PortableManifest; bake: Bake }> {
  const signal = transferSignal(options.signal);
  const limit = byteLimit(options.maxBytes);
  const file = await Deno.open(path, { read: true });
  const reader = file.readable.pipeThrough(new DecompressionStream("gzip")).getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const input = new ArchiveReader(reader, signal, limit);
  try {
    if (canonical([...await input.exact(magic.length)]) !== canonical([...magic])) {
      throw new Error("Not a Panda snapshot archive");
    }
    const length = new DataView((await input.exact(4)).buffer).getUint32(0);
    if (!length || length > headerLimit) throw new Error("Snapshot header exceeds limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await input.exact(length));
    const header = JSON.parse(text);
    if (text !== canonical(header)) {
      throw new Error("Snapshot header must use canonical JSON without duplicate keys");
    }
    validateHeader(header, input.limit);
    const bake = await compatibleBake(header, options.bake);
    const bytes = Object.values(header.files as SnapshotManifest["files"]).reduce(
      (sum, f) => sum + f.size,
      0,
    );
    const disk = await statfs(dirname(directory));
    if (disk.bavail * disk.bsize < bytes + Math.max(16 * 1024 * 1024, bytes * 0.05)) {
      throw new Error("Insufficient free space to import snapshot");
    }
    await Deno.mkdir(directory, { mode: 0o700 });
    const metadata = header.metadata as PortableManifest["metadata"];
    for (const name of Object.keys(metadata).sort()) {
      if (name !== "." && metadata[name].type === "directory") {
        await Deno.mkdir(join(directory, name), { mode: metadata[name].mode | 0o700 });
      }
    }
    for (const name of Object.keys(header.files).sort()) {
      signal.throwIfAborted();
      using output = await Deno.open(join(directory, name), {
        createNew: true,
        write: true,
        mode: metadata[name].mode | 0o600,
      });
      const hash = createHash("sha256");
      let remaining = header.files[name].size;
      while (remaining) {
        const chunk = await input.take(remaining);
        if (!chunk.length) throw new Error("Truncated snapshot file");
        remaining -= chunk.length;
        hash.update(chunk);
        await writeAll(output, chunk);
      }
      if (hash.digest("hex") !== header.files[name].hash) {
        throw new Error("Snapshot file integrity failure");
      }
      await output.sync();
    }
    if ((await input.take(1)).length) throw new Error("Trailing snapshot archive data");
    signal.throwIfAborted();
    for (const name of Object.keys(metadata).sort().reverse()) {
      if (metadata[name].type === "directory") await syncDirectory(join(directory, name));
    }
    return { header, bake };
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
