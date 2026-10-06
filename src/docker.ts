// @deno-types="@types/dockerode"
import Docker from "dockerode";
import { Readable, Writable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { finished, pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { BakedImage } from "./profiles.ts";
import { join } from "node:path";
import {
  type ActiveGeneration,
  fileInventory,
  StateLock,
  type StateStore,
  treeMetadata,
} from "./storage.ts";
import { deadline } from "./http.ts";

export const LABEL = "io.panda.id";
export const ROLE = "io.panda.role";
export const GENERATION = "io.panda.generation";
export function dockerClient(): Docker {
  const host = Deno.env.get("DOCKER_HOST");
  const explicit = Deno.env.get("PANDA_DOCKER_SOCKET");
  if (host && !host.startsWith("unix://") && !explicit) {
    throw new Error("Use a local Unix Docker socket (PANDA_DOCKER_SOCKET or DOCKER_HOST=unix://…)");
  }
  const desktop = `${Deno.env.get("HOME")}/.docker/run/docker.sock`;
  let fallback = "/var/run/docker.sock";
  try {
    if (Deno.statSync(desktop)) fallback = desktop;
  } catch { /* Linux default */ }
  return new Docker({
    socketPath: explicit ?? host?.slice(7) ?? fallback,
    // dockerode also reads DOCKER_HOST; keep our explicit local socket authoritative.
    host: undefined,
    protocol: "http",
  });
}

export function missing(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 404;
}

export class Infrastructure {
  readonly docker: Docker;
  readonly labels: Record<string, string>;
  constructor(readonly id: string, docker = dockerClient()) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Invalid devnet id");
    this.docker = docker;
    this.labels = { [LABEL]: id };
  }
  useGeneration(generation: string): void {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(generation)) {
      throw new Error("Invalid generation ID");
    }
    this.labels[GENERATION] = generation;
  }
  async assertGenerationUnused(generation: string): Promise<void> {
    const clients = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${this.id}`, `${GENERATION}=${generation}`] },
    });
    if (clients.length) throw new Error(`Generation ${generation} still has client containers`);
  }
  /** Copy a stopped generation without publishing it. Failed copies remain inactive evidence. */
  async copyGeneration(
    store: StateStore,
    source: ActiveGeneration,
    destination: ActiveGeneration,
  ): Promise<void> {
    if (store.id !== this.id || source.id !== this.id || destination.id !== this.id) {
      throw new Error("Generation copy ownership mismatch");
    }
    if (source.generation === destination.generation) {
      throw new Error("Cannot copy a generation onto itself");
    }
    const from = await store.validate(source);
    const to = await store.validate(destination);
    const lock = await StateLock.acquire(join(store.root, "network.lock"));
    try {
      const active = await store.resumable();
      if (active.generation !== source.generation) {
        throw new Error("Copy source must be the stopped active generation");
      }
      if (
        active.bakeKey !== destination.bakeKey ||
        JSON.stringify(active.config) !== JSON.stringify(destination.config)
      ) throw new Error("Generation copy configuration or bake mismatch");
      // A durable phase alone must not authorize copying files still open in a client.
      for (const generation of [source.generation, destination.generation]) {
        const clients = await this.docker.listContainers({
          all: true,
          filters: { label: [`${LABEL}=${this.id}`, `${GENERATION}=${generation}`] },
        });
        if (clients.some((client) => !["created", "exited", "dead"].includes(client.State))) {
          throw new Error("Cannot copy a generation with a live client");
        }
      }
      await this.copyTree(from, to);
    } finally {
      lock.release();
    }
  }
  /** Copy immutable snapshot data into an inactive owned generation; the live source is untouched. */
  async copySnapshot(
    store: StateStore,
    snapshot: string,
    destination: ActiveGeneration,
  ): Promise<void> {
    if (store.id !== this.id || destination.id !== this.id) {
      throw new Error("Snapshot copy ownership mismatch");
    }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(snapshot)) {
      throw new Error("Invalid snapshot ID");
    }
    const parent = join(await store.snapshotsDirectory(), snapshot);
    const from = join(parent, "data");
    for (const path of [parent, from]) {
      const info = await Deno.lstat(path);
      if (!info.isDirectory || info.isSymlink) throw new Error("Unsafe snapshot directory");
    }
    const to = await store.validate(destination);
    if ((await store.active())?.generation === destination.generation) {
      throw new Error("Snapshot destination must be inactive");
    }
    const clients = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${this.id}`, `${GENERATION}=${destination.generation}`] },
    });
    if (clients.some((client) => !["created", "exited", "dead"].includes(client.State))) {
      throw new Error("Cannot copy a generation with a live client");
    }
    await this.copyTree(from, to);
  }
  private async copyTree(from: string, to: string): Promise<void> {
    for await (const entry of Deno.readDir(to)) {
      if (entry.name === "owner.json") continue;
      if (!["el", "bn", "shared"].includes(entry.name) || !entry.isDirectory || entry.isSymlink) {
        throw new Error("Copy destination must be an empty owned generation");
      }
      for await (const _child of Deno.readDir(join(to, entry.name))) {
        throw new Error("Copy destination must be empty");
      }
    }
    const entries: { relative: string; info: Deno.FileInfo }[] = [];
    const inspect = async (relative: string): Promise<void> => {
      const path = join(from, relative);
      const info = await Deno.lstat(path);
      if (info.isSymlink || (!info.isDirectory && !info.isFile)) {
        throw new Error("Unsupported link or special file in generation copy");
      }
      entries.push({ relative, info });
      if (info.isDirectory) {
        const names = [];
        for await (const entry of Deno.readDir(path)) names.push(entry.name);
        for (const name of names.sort()) {
          if (!relative && name === "owner.json") continue;
          await inspect(relative ? `${relative}/${name}` : name);
        }
      }
    };
    // Validate the complete source before writing any data into the destination.
    await inspect("");
    const inventory = async (root: string) => {
      const files = await fileInventory(root);
      const metadata = await treeMetadata(root);
      // The destination has its own ownership marker, which is deliberately not copied.
      delete files["owner.json"];
      delete metadata["owner.json"];
      return JSON.stringify({ files, metadata });
    };
    const expected = await inventory(from);
    for (const { relative, info } of entries) {
      const target = join(to, relative);
      if (info.isDirectory) await Deno.mkdir(target, { recursive: true, mode: 0o700 });
      else {
        await Deno.copyFile(join(from, relative), target);
        using file = await Deno.open(target, { read: true });
        await file.sync();
      }
    }
    // Apply directory modes after children are written, including read-only source trees.
    for (const { relative, info } of entries.toReversed()) {
      const target = join(to, relative);
      if (info.uid !== null && info.gid !== null) await Deno.chown(target, info.uid, info.gid);
      if (info.mode !== null) await Deno.chmod(target, info.mode & 0o7777);
      if (info.atime && info.mtime) await Deno.utime(target, info.atime, info.mtime);
      using entry = await Deno.open(target, { read: true });
      await entry.sync();
    }
    if (await inventory(from) !== expected || await inventory(to) !== expected) {
      throw new Error("Generation copy integrity failure: source or copied files changed");
    }
  }
  private get filters() {
    return { label: Object.entries(this.labels).map(([key, value]) => `${key}=${value}`) };
  }
  /** A successful Docker stop is insufficient when the watchdog killed a client. */
  async stopClients(timeoutMs: number, afterValidatorStopped?: () => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) {
      throw new Error("Invalid stop timeout");
    }
    const end = performance.now() + timeoutMs;
    const bounded = <T>(description: string, run: () => Promise<T>): Promise<T> => {
      const remaining = end - performance.now();
      if (remaining <= 0) throw new Error(`Timed out: ${description}`);
      return deadline(run(), remaining, description);
    };
    for (const role of ["vc", "bn", "el"]) {
      const found = await bounded(`${role} lookup before stop`, () =>
        this.docker.listContainers({
          all: true,
          filters: { label: [...this.filters.label, `${ROLE}=${role}`] },
        }));
      if (found.length !== 1) throw new Error(`Expected exactly one owned ${role} client`);
      const container = this.docker.getContainer(found[0].Id);
      const info = await bounded(`${role} ownership before stop`, () => container.inspect());
      if (Object.entries(this.labels).some(([key, value]) => info.Config.Labels?.[key] !== value)) {
        throw new Error(`Foreign ${role} client`);
      }
      if (!info.State.Running) throw new Error(`${role} exited before clean stop`);
      await bounded(
        `${role} graceful stop`,
        () => container.stop({ t: Math.max(1, Math.ceil((end - performance.now()) / 1000)) }),
      );
      const stopped = await bounded(`${role} exit verification`, () => container.inspect());
      if (stopped.State.Running || stopped.State.OOMKilled || stopped.State.ExitCode !== 0) {
        throw new Error(`${role} did not stop cleanly (exit ${stopped.State.ExitCode})`);
      }
      if (role === "vc") await afterValidatorStopped?.();
      // Each owned client container starts only once. These logs belong to this process,
      // not an earlier restart whose successful persistence could mask the current failure.
      const logs = await bounded(`${role} persistence acknowledgement`, () => this.logs(container));
      if (
        role === "bn" && (!logs.includes("Saved beacon chain to disk") ||
          logs.includes("Failed to persist on BeaconChain drop"))
      ) {
        throw new Error("Beacon persistence was not confirmed");
      }
      if (
        role === "el" && (!logs.includes("Blockchain stopped") ||
          !/Persisted dirty state to (file|disk)/.test(logs) ||
          /Failed to (journal|commit recent state trie|close trie database)|Dangling trie nodes after full cleanup/
            .test(logs))
      ) {
        throw new Error("Execution persistence was not confirmed");
      }
    }
  }
  /** Docker can return HTTP 200 with an operation error in its JSON progress stream. */
  async progress(stream: NodeJS.ReadableStream): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (error: Error | null, events: { error?: string; errorDetail?: { message?: string } }[]) => {
          const failure = events?.find((event) => event.error || event.errorDetail?.message);
          if (error) reject(error);
          else if (failure) reject(new Error(failure.errorDetail?.message ?? failure.error));
          else resolve();
        },
      );
    });
  }
  async image(ref: string, authconfig?: Docker.AuthConfig): Promise<void> {
    try {
      await this.docker.getImage(ref).inspect();
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (/^sha256:[a-f0-9]{64}$/.test(ref)) {
      if (await this.restoreImage(ref)) return;
      throw new Error(`Local image ${ref} is missing`);
    }
    const stream = await this.docker.pull(ref, { authconfig });
    await this.progress(stream);
  }
  async registryImage(image: BakedImage, authconfig?: Docker.AuthConfig): Promise<void> {
    if (!image.digest || !/@sha256:[a-f0-9]{64}$/.test(image.digest)) {
      throw new Error("Registry restore requires an immutable digest");
    }
    await this.image(image.digest, authconfig);
    const found = await this.docker.getImage(image.digest).inspect();
    if (found.Id !== image.id || `${found.Os}/${found.Architecture}` !== image.platform) {
      throw new Error(`Published image identity/platform mismatch: ${image.digest}`);
    }
  }
  async publishImage(id: string, ref: string, authconfig: Docker.AuthConfig): Promise<string> {
    const image = this.docker.getImage(id);
    if ((await image.inspect()).Config.Labels?.[LABEL] !== this.id) {
      throw new Error(`Cannot publish an image not owned by ${this.id}`);
    }
    const separator = ref.lastIndexOf(":");
    if (separator < 0 || ref.includes("@")) {
      throw new Error("Publication requires a repository:tag");
    }
    const repo = ref.slice(0, separator);
    await image.tag({ repo, tag: ref.slice(separator + 1) });
    const stream = await this.docker.getImage(ref).push({ authconfig });
    await this.progress(stream);
    const published = await this.docker.getImage(ref).inspect();
    const digest = published.RepoDigests?.find((value) => value.startsWith(`${repo}@sha256:`));
    if (published.Id !== id || !digest) throw new Error("Published image identity/digest mismatch");
    return digest;
  }
  private imageArchive(id: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Expected immutable image ID");
    return `.cache/baker/images/${id.slice(7)}.tar.gz`;
  }
  async cacheImage(id: string): Promise<void> {
    const path = this.imageArchive(id);
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.mkdir(".cache/baker/images", { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await pipeline(
        await this.docker.getImage(id).get(),
        createGzip(),
        createWriteStream(temporary),
      );
      await Deno.rename(temporary, path);
    } finally {
      await Deno.remove(temporary).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
  async restoreImage(id: string): Promise<boolean> {
    const path = this.imageArchive(id);
    try {
      await Deno.stat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
    const stream = await this.docker.loadImage(createReadStream(path));
    await this.progress(stream);
    if ((await this.docker.getImage(id).inspect()).Id !== id) {
      throw new Error(`Restored bake image identity mismatch: ${id}`);
    }
    return true;
  }
  async network(): Promise<string> {
    const result = await this.docker.createNetwork({
      Name: `panda-${this.id}`,
      Labels: this.labels,
      Driver: "bridge",
    });
    return result.id;
  }
  async volume(role: string): Promise<string> {
    const name = `panda-${this.id}-${role}`;
    try {
      const existing = await this.docker.getVolume(name).inspect();
      if (existing.Labels?.[LABEL] !== this.id) throw new Error(`Foreign volume: ${name}`);
      return name;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await this.docker.createVolume({ Name: name, Labels: { ...this.labels, [ROLE]: role } });
    return name;
  }
  async container(role: string, options: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    return await this.docker.createContainer({
      ...options,
      name: `panda-${this.id}-${role}`,
      Labels: { ...options.Labels, ...this.labels, [ROLE]: role },
    });
  }
  async compilerContainer(
    role: "cl" | "el",
    options: Docker.ContainerCreateOptions,
  ): Promise<Docker.Container> {
    // Docker Desktop and CI can expose fewer CPUs than the controller's host.
    const { NCPU } = await this.docker.info();
    if (!Number.isSafeInteger(NCPU) || NCPU < 1) {
      throw new Error(`Docker reported an invalid CPU count: ${NCPU}`);
    }
    return await this.container(role, {
      ...options,
      HostConfig: { ...options.HostConfig, NanoCpus: Math.min(4, NCPU) * 1e9 },
    });
  }
  async logs(container: Docker.Container): Promise<string> {
    const data = await container.logs({ stdout: true, stderr: true, tail: 300 });
    const output: Uint8Array[] = [];
    const writer = new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk);
        callback();
      },
    });
    // Docker returns multiplexed frames when Tty=false, including for non-streaming logs.
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    this.docker.modem.demuxStream(stream, writer, writer);
    stream.end(data);
    return output.map((x) => new TextDecoder().decode(x)).join("");
  }
  async clientLogs(
    role: "el" | "bn" | "vc",
    options: { follow?: boolean; tail?: number | "all" },
    stdout: Writable,
    stderr: Writable,
  ): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${this.id}`, `${ROLE}=${role}`] },
    });
    if (containers.length !== 1) throw new Error(`Expected exactly one owned ${role} client`);
    const container = this.docker.getContainer(containers[0].Id);
    const logOptions = {
      stdout: true,
      stderr: true,
      ...(options.tail === "all" ? {} : { tail: options.tail ?? 300 }),
    };
    const data = options.follow
      ? await container.logs({ ...logOptions, follow: true })
      : await container.logs({ ...logOptions, follow: false });
    const stream = data instanceof Uint8Array ? Readable.from([data]) : data as Readable;
    const done = finished(stream, { cleanup: true });
    this.docker.modem.demuxStream(stream, stdout, stderr);
    await done;
  }
  async exec(container: Docker.Container, cmd: string[]): Promise<string> {
    const instance = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await instance.start({ Detach: false });
    let output = "";
    const writer = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    this.docker.modem.demuxStream(stream, writer, writer);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const status = await instance.inspect();
    if (status.ExitCode !== 0) throw new Error(`exec failed (${status.ExitCode}): ${output}`);
    return output;
  }
  async cleanup(scope: "generation" | "network" = "generation"): Promise<void> {
    const filters = scope === "network" ? { label: [`${LABEL}=${this.id}`] } : this.filters;
    const errors: unknown[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        if (!missing(error)) errors.push(error);
      }
    };
    for (const entry of await this.docker.listContainers({ all: true, filters })) {
      const container = this.docker.getContainer(entry.Id);
      if (entry.State === "running") await attempt(() => container.stop({ t: 5 }));
      await attempt(() => container.remove({ force: true, v: true }));
    }
    for (const entry of await this.docker.listNetworks({ filters })) {
      await attempt(() => this.docker.getNetwork(entry.Id).remove());
    }
    for (const entry of (await this.docker.listVolumes({ filters })).Volumes ?? []) {
      await attempt(() => this.docker.getVolume(entry.Name).remove());
    }
    if (errors.length) throw new AggregateError(errors, `Cleanup failed for ${this.id}`);
  }
}
