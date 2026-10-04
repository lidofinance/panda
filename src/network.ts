import { type Bake, clockEnvironment, readBake } from "./profiles.ts";
import { requireImage } from "./artifacts.ts";
import { account, type Config, configuration, mnemonic } from "./config.ts";
import { GENERATION, Infrastructure, LABEL, ROLE } from "./docker.ts";
import { checkEngineCapabilities, EngineGate } from "./engine.ts";
import { defaultTimeoutMs, json, rpc, waitFor, withWatchdog } from "./http.ts";
import {
  type ActiveGeneration,
  type Checkpoint,
  durableJson,
  fileInventory,
  stateDirectory,
  StateLock,
  StateStore,
} from "./storage.ts";

export interface Manifest {
  bake: Bake;
  config: Config;
  el: string;
  beacon: string;
  bnClock: string;
  vcClock: string;
  vc: string;
  directory: string;
  generation?: string;
}
export class Network {
  engine?: EngineGate;
  private lock?: StateLock;
  private get lockOwned(): boolean {
    return this.lock !== undefined;
  }
  readonly infra: Infrastructure;
  readonly store: StateStore;
  generation?: ActiveGeneration;
  get directory(): string {
    return this.generation
      ? `${this.store.generationPath(this.generation.generation)}/shared`
      : this.store.root;
  }
  constructor(readonly config: Config) {
    this.infra = new Infrastructure(config.id);
    this.store = new StateStore(config.id);
  }
  async start(mode: "new" | "resume" | "auto" = "new", signal?: AbortSignal): Promise<Manifest> {
    signal?.throwIfAborted();
    await this.store.initialize();
    signal?.throwIfAborted();
    this.lock = await StateLock.acquire(`${this.store.root}/network.lock`);
    try {
      signal?.throwIfAborted();
      return await this.startOwned(mode, signal);
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }
  private releaseLock(): void {
    this.lock?.release();
    this.lock = undefined;
  }
  private async startOwned(
    mode: "new" | "resume" | "auto",
    signal?: AbortSignal,
  ): Promise<Manifest> {
    const active = await this.store.active();
    signal?.throwIfAborted();
    const resume = mode === "resume" || mode === "auto" && active !== undefined;
    if (resume) {
      this.generation = await this.store.resumable();
      if (JSON.stringify(this.generation.config) !== JSON.stringify(this.config)) {
        throw new Error("Preserved generation configuration mismatch");
      }
    } else if (active) {
      throw new Error("Active generation exists; resume it or use down/reset");
    }
    const filters = { label: [`${LABEL}=${this.config.id}`] };
    signal?.throwIfAborted();
    const [existing, networks, volumes] = await Promise.all([
      this.infra.docker.listContainers({ all: true, filters }),
      this.infra.docker.listNetworks({ filters }),
      this.infra.docker.listVolumes({ filters }),
    ]);
    signal?.throwIfAborted();
    if (existing.length || networks.length || volumes.Volumes?.length) {
      throw new Error(
        `Devnet ${this.config.id} already has resources; use down/reset or connect()`,
      );
    }
    const { config, infra } = this;
    const sharedUser = `${Deno.uid()}:${Deno.gid()}`;
    const bake = await readBake(config.profile, config.bake);
    signal?.throwIfAborted();
    if (resume && (bake.key !== this.generation!.bakeKey || bake.recipe.checkpointAbi !== 1)) {
      throw new Error("Preserved generation requires its exact checkpoint-capable bake");
    }
    const recipe = bake.recipe;
    const startMs = resume
      ? this.generation!.checkpoint!.nowMs
      : config.genesisTime * 1000 + 11_500;
    const clockEnv = config.mode === "controlled"
      ? [
        `${clockEnvironment(recipe).startMs}=${startMs}`,
        `${clockEnvironment(recipe).port}=5059`,
        ...(resume ? ["PANDA_CLOCK_PARKED=1"] : []),
      ]
      : [];
    const images = {
      geth: await requireImage(infra, bake.images.el),
      genesis: await requireImage(infra, bake.images.genesis),
    };
    signal?.throwIfAborted();
    const clientImage = await requireImage(
      infra,
      config.mode === "controlled" ? bake.images.cl : bake.images.baseline,
    );
    signal?.throwIfAborted();
    const started = performance.now();
    try {
      this.generation ??= await this.store.create(config, bake.key);
      signal?.throwIfAborted();
      infra.useGeneration(this.generation.generation);
      const generationPath = await this.store.validate(this.generation);
      const directory = this.directory;
      signal?.throwIfAborted();
      await this.store.write({ ...this.generation, phase: "starting" });
      signal?.throwIfAborted();
      if (resume) {
        const expected = this.generation.checkpoint!.sharedFiles;
        const shared = await this.sharedInventory();
        signal?.throwIfAborted();
        if (
          !expected || JSON.stringify(shared) !== JSON.stringify(expected)
        ) {
          throw new Error("Preserved genesis, keys or slashing protection data changed");
        }
        const databases = this.generation.checkpoint!.databaseFiles;
        const actual = await this.databaseInventory();
        signal?.throwIfAborted();
        if (
          !databases || JSON.stringify(actual) !== JSON.stringify(databases)
        ) {
          throw new Error("Preserved execution or consensus database files changed");
        }
        await this.validateValidatorData();
      }
      signal?.throwIfAborted();
      const network = await infra.network();
      signal?.throwIfAborted();
      const data = `${generationPath}/el`;
      const beaconData = `${generationPath}/bn`;
      const env = [
        `CHAIN_ID=${config.chainId}`,
        `NUMBER_OF_VALIDATORS=${config.validators}`,
        `EL_AND_CL_MNEMONIC=${mnemonic}`,
        `CHURN_LIMIT_QUOTIENT=${config.churnLimitQuotient}`,
        `GENESIS_TIMESTAMP=${config.genesisTime}`,
        "GENESIS_DELAY=0",
        "DEPOSIT_CONTRACT_ADDRESS=0x4242424242424242424242424242424242424242",
        ...Object.entries(recipe.genesisEnv).map(([name, value]) => `${name}=${value}`),
        ...(config.profile === "gloas"
          ? [
            `CHURN_LIMIT_QUOTIENT_GLOAS=${config.churnLimitQuotient}`,
            `CONSOLIDATION_CHURN_LIMIT_QUOTIENT=${config.consolidationChurnLimitQuotient}`,
          ]
          : []),
        "WITHDRAWAL_TYPE=0x01",
        `WITHDRAWAL_ADDRESS=${account}`,
        `EL_PREMINE_ADDRS={"${account}":{"balance":"1000000ETH"}}`,
      ];
      const oneShot = async (role: string, options: Parameters<Infrastructure["container"]>[1]) => {
        signal?.throwIfAborted();
        const c = await infra.container(role, options);
        signal?.throwIfAborted();
        await c.start();
        signal?.throwIfAborted();
        const budget = AbortSignal.timeout(defaultTimeoutMs());
        const result = await c.wait({
          abortSignal: signal ? AbortSignal.any([signal, budget]) : budget,
        });
        signal?.throwIfAborted();
        const logs = await infra.logs(c);
        signal?.throwIfAborted();
        await this.saveLog(role, logs, this.generation!.generation);
        signal?.throwIfAborted();
        if (result.StatusCode !== 0) throw new Error(`${role} failed: ${logs}`);
        await c.remove({ v: true });
        signal?.throwIfAborted();
      };
      if (!resume) {
        await oneShot("genesis", {
          Image: images.genesis,
          User: sharedUser,
          Env: env,
          Entrypoint: ["/bin/bash"],
          Cmd: [
            "-ec",
            '/work/entrypoint.sh all; eth2-val-tools keystores --insecure --source-min 0 --source-max "$NUMBER_OF_VALIDATORS" --source-mnemonic "$EL_AND_CL_MNEMONIC" --out-loc /data/validator-keys',
          ],
          HostConfig: { Binds: [`${directory}:/data`], NetworkMode: network },
        });
        await Deno.writeTextFile(`${directory}/metadata/bootstrap_nodes.txt`, "");
        await oneShot("init", {
          Image: images.geth,
          User: sharedUser,
          Cmd: ["--datadir=/el", "init", "/shared/metadata/genesis.json"],
          HostConfig: { Binds: [`${directory}:/shared:ro`, `${data}:/el`], NetworkMode: network },
        });
      }
      const port = (value: string) => ({ [value]: [{ HostIp: "127.0.0.1", HostPort: "" }] });
      const start = async (role: string, options: Parameters<Infrastructure["container"]>[1]) => {
        signal?.throwIfAborted();
        const container = await infra.container(role, options);
        signal?.throwIfAborted();
        await container.start();
        signal?.throwIfAborted();
        const info = await container.inspect();
        signal?.throwIfAborted();
        return (p: number) =>
          `http://127.0.0.1:${info.NetworkSettings.Ports[`${p}/tcp`]?.[0]?.HostPort}`;
      };
      const el = await start("el", {
        Image: images.geth,
        User: sharedUser,
        Cmd: [
          "--datadir=/el",
          `--networkid=${config.chainId}`,
          "--http",
          "--http.addr=0.0.0.0",
          "--http.vhosts=*",
          "--http.api=eth,net,web3,txpool",
          "--authrpc.addr=0.0.0.0",
          "--authrpc.vhosts=*",
          "--authrpc.jwtsecret=/shared/jwt/jwtsecret",
          "--nodiscover",
          "--maxpeers=0",
          "--syncmode=full",
          "--cache=64",
          "--verbosity=3",
          "--log.json",
        ],
        ExposedPorts: { "8545/tcp": {}, "8551/tcp": {} },
        HostConfig: {
          Binds: [`${directory}:/shared:ro`, `${data}:/el`],
          NetworkMode: network,
          PortBindings: { ...port("8545/tcp"), ...port("8551/tcp") },
          MemoryReservation: 128 * 1024 ** 2,
          NanoCpus: 2e9,
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: ["el"] } } },
      });
      await waitFor(
        "Geth RPC",
        (signal) => rpc(el(8545), "eth_chainId", [], withWatchdog(signal)),
        defaultTimeoutMs(),
        signal,
      );
      await checkEngineCapabilities(
        el(8551),
        await Deno.readTextFile(`${directory}/jwt/jwtsecret`),
        recipe.engineMethods,
        signal,
      );
      signal?.throwIfAborted();
      if (config.mode === "controlled") {
        this.engine = await EngineGate.start(
          infra,
          infra.docker.getContainer(`panda-${config.id}-el`),
          el(8551),
          startMs,
          await Deno.readTextFile(`${directory}/jwt/jwtsecret`),
          signal,
        );
        signal?.throwIfAborted();
      }
      const bn = await start("bn", {
        Image: clientImage,
        User: sharedUser,
        Entrypoint: ["lighthouse"],
        Env: [...clockEnv, ...(resume ? ["PANDA_REQUIRE_CHECKPOINT=1"] : [])],
        Cmd: [
          "--testnet-dir=/shared/metadata",
          "beacon_node",
          "--datadir=/bn",
          `--execution-endpoint=${this.engine?.url ?? "http://el:8551"}`,
          "--execution-jwt=/shared/jwt/jwtsecret",
          "--http",
          "--http-address=0.0.0.0",
          "--http-allow-origin=*",
          "--disable-discovery",
          "--disable-upnp",
          "--target-peers=0",
          "--staking",
          "--disable-packet-filter",
          "--epochs-per-blob-prune=1",
          ...(config.profile === "gloas" ? ["--supernode"] : []),
          // Small local registries favor fewer disk diffs during large empty-slot ranges.
          // This is Lighthouse's storage layout; consensus constants remain unchanged.
          ...(config.mode === "controlled" && recipe.preparedSkip
            ? ["--hierarchy-exponents=9,13,16,18,21"]
            : []),
        ],
        ExposedPorts: { "5052/tcp": {}, "5059/tcp": {} },
        HostConfig: {
          Binds: [`${directory}:/shared:ro`, `${beaconData}:/bn`],
          NetworkMode: network,
          PortBindings: { ...port("5052/tcp"), ...port("5059/tcp") },
          MemoryReservation: 512 * 1024 ** 2,
          NanoCpus: 2e9,
          ExtraHosts: Deno.build.os === "linux" ? ["host.docker.internal:host-gateway"] : undefined,
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: ["bn"] } } },
      });
      await waitFor(
        "Beacon API",
        (signal) => json(`${bn(5052)}/eth/v1/beacon/genesis`, { signal: withWatchdog(signal) }),
        defaultTimeoutMs(),
        signal,
      );
      const vc = await start("vc", {
        Image: clientImage,
        User: sharedUser,
        Entrypoint: ["lighthouse"],
        Env: clockEnv,
        Cmd: [
          "--testnet-dir=/shared/metadata",
          "validator_client",
          "--validators-dir=/shared/validator-keys/keys",
          "--secrets-dir=/shared/validator-keys/secrets",
          "--beacon-nodes=http://bn:5052",
          ...(config.profile === "gloas" && config.mode === "controlled" && !recipe.preparedSkip
            ? ["--use-long-timeouts", "--long-timeouts-multiplier=60"]
            : []),
          ...(!resume ? ["--init-slashing-protection"] : []),
          `--suggested-fee-recipient=${account}`,
          "--http",
          "--http-address=0.0.0.0",
          "--unencrypted-http-transport",
        ],
        ExposedPorts: { "5062/tcp": {}, "5059/tcp": {} },
        HostConfig: {
          Binds: [`${directory}:/shared`],
          NetworkMode: network,
          PortBindings: { ...port("5062/tcp"), ...port("5059/tcp") },
          MemoryReservation: 128 * 1024 ** 2,
          NanoCpus: 2e9,
        },
      });
      const manifest: Manifest = {
        bake,
        config,
        directory,
        generation: this.generation.generation,
        el: el(8545),
        beacon: bn(5052),
        bnClock: bn(5059),
        vcClock: vc(5059),
        vc: vc(5062),
      };
      if (config.mode === "controlled") {
        await waitFor(
          "validator clock and services",
          async (signal) => {
            const clock = await json<{ marks: Record<string, number> }>(vc(5059), {
              signal: withWatchdog(signal),
            });
            return (resume
                ? clock.marks.parked_ready === 0
                : clock.marks.ready === 0 && clock.marks.indices === 0)
              ? clock
              : undefined;
          },
          defaultTimeoutMs(),
          signal,
        );
      }
      signal?.throwIfAborted();
      await durableJson(`${this.store.root}/manifest.json`, manifest);
      signal?.throwIfAborted();
      if (!resume) await this.setPhase("running");
      signal?.throwIfAborted();
      console.log(
        JSON.stringify({
          event: "network-started",
          id: config.id,
          elapsedMs: performance.now() - started,
          ...manifest,
          bake: { profile: bake.profile, tag: bake.tag, key: bake.key },
        }),
      );
      return manifest;
    } catch (error) {
      const errors = [error];
      try {
        await this.engine?.close();
      } catch (engine) {
        errors.push(engine);
      }
      try {
        await this.saveLogs();
      } catch (logs) {
        errors.push(logs);
      }
      try {
        await infra.cleanup();
      } catch (cleanup) {
        errors.push(cleanup);
      }
      try {
        if (resume) await this.setPhase("faulted", undefined, String(error));
        else {
          if (this.generation) await this.store.destroy(this.generation);
          this.generation = undefined;
        }
      } catch (storage) {
        errors.push(storage);
      }
      throw errors.length === 1 ? error : new AggregateError(errors, "Startup failed");
    }
  }
  async saveLogs(): Promise<void> {
    await this.store.initialize();
    const containers = await this.infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${this.config.id}`] },
    });
    for (const c of containers) {
      if (c.Labels[LABEL] !== this.config.id) throw new Error("Client log ownership mismatch");
      await this.saveLog(
        c.Labels[ROLE],
        await this.infra.logs(this.infra.docker.getContainer(c.Id)),
        c.Labels[GENERATION],
      );
    }
  }
  /** Diagnostics outlive destructive down/reset and are never part of checkpoint databases. */
  private async saveLog(role: string, text: string, generation?: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(role)) throw new Error("Invalid client log role");
    if (generation !== undefined) this.store.generationPath(generation);
    const directory = `${this.store.root}/logs/${generation ?? "runtime"}`;
    for (const path of [`${this.store.root}/logs`, directory]) {
      await Deno.mkdir(path, { mode: 0o700 }).catch((error) => {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      });
      const info = await Deno.lstat(path);
      if (!info.isDirectory || info.isSymlink) throw new Error("Unsafe diagnostic log directory");
    }
    const path = `${directory}/${role}.log`;
    try {
      const info = await Deno.lstat(path);
      if (!info.isFile || info.isSymlink) throw new Error("Unsafe diagnostic log file");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await Deno.writeTextFile(path, text, { mode: 0o600 });
  }
  async setPhase(
    phase: ActiveGeneration["phase"],
    checkpoint?: Checkpoint,
    error?: string,
  ): Promise<void> {
    if (!this.generation) throw new Error("No active generation");
    const next = {
      ...this.generation,
      phase,
      checkpoint: checkpoint ?? this.generation.checkpoint,
      error,
    };
    await this.store.write(next);
    this.generation = next;
  }
  private async validateValidatorData(): Promise<void> {
    const keys = `${this.directory}/validator-keys/keys`;
    const path = `${keys}/slashing_protection.sqlite`;
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) throw new Error("Missing or unsafe slashing protection DB");
    using db = await Deno.open(path, { read: true });
    const header = new Uint8Array(16);
    if (await db.read(header) !== 16 || new TextDecoder().decode(header) !== "SQLite format 3\0") {
      throw new Error("Invalid slashing protection DB");
    }
    const definitions = await Deno.readTextFile(`${keys}/validator_definitions.yml`);
    if (/web3signer|remote_signer|http:|https:/i.test(definitions)) {
      throw new Error("Checkpoint requires disposable local validator keys");
    }
    const paths = [
      ...definitions.matchAll(/(?:keystore_path|keystore_password_path):\s*["']?([^\s"']+)/g),
    ];
    if (!paths.length) throw new Error("Missing local validator definitions");
    for (const match of paths) {
      const clientPath = match[1];
      if (
        !clientPath.startsWith("/shared/validator-keys/") || clientPath.split("/").includes("..")
      ) {
        throw new Error("Validator path escapes generation");
      }
      const local = `${this.directory}/${clientPath.slice("/shared/".length)}`;
      const stat = await Deno.lstat(local);
      if (!stat.isFile || stat.isSymlink) throw new Error("Missing or unsafe validator key/secret");
    }
  }
  private async sharedInventory(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const name of ["metadata", "jwt", "validator-keys"]) {
      result[name] = await fileInventory(`${this.directory}/${name}`);
    }
    return result;
  }
  private async databaseInventory(): Promise<Record<string, unknown>> {
    const path = this.store.generationPath(this.generation!.generation);
    return {
      el: await fileInventory(`${path}/el`),
      bn: await fileInventory(`${path}/bn`),
    };
  }
  async preserve(checkpoint: Checkpoint, timeoutMs = defaultTimeoutMs()): Promise<void> {
    if (!this.lockOwned || !this.generation) {
      throw new Error("Network is not owned by this controller");
    }
    await this.validateValidatorData();
    await this.setPhase("stopping", checkpoint);
    try {
      await this.infra.stopClients(timeoutMs);
      await this.saveLogs();
      await this.engine?.close();
      await this.infra.cleanup();
      await this.setPhase("stopped", {
        ...checkpoint,
        sharedFiles: await this.sharedInventory(),
        databaseFiles: await this.databaseInventory(),
      });
      await this.releaseLock();
    } catch (error) {
      await this.setPhase("faulted", checkpoint, String(error));
      throw error;
    }
  }
  /** Failed resume retains evidence and data; it must never silently become a fresh network. */
  async fail(error: unknown): Promise<void> {
    const errors: unknown[] = [];
    try {
      for (
        const cleanup of [
          () =>
            this.generation
              ? this.setPhase("faulted", undefined, String(error))
              : Promise.resolve(),
          () => this.saveLogs(),
          () => this.engine?.close(),
          () => this.infra.cleanup(),
        ]
      ) {
        try {
          await cleanup();
        } catch (failure) {
          errors.push(failure);
        }
      }
    } finally {
      await this.releaseLock();
    }
    if (errors.length) {
      throw new AggregateError(
        [error, ...errors],
        `Failed resume cleanup: ${errors.map(String).join("; ")}`,
      );
    }
  }
  async skipValidator(manifest: Manifest, nowMs: number): Promise<void> {
    const started = performance.now();
    const listed = await this.infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${this.config.id}`, `${ROLE}=vc`] },
    });
    if (listed.length !== 1) throw new Error("Expected exactly one owned validator client");
    const old = this.infra.docker.getContainer(listed[0].Id);
    const info = await old.inspect();
    if (manifest.generation) this.infra.useGeneration(manifest.generation);
    await old.stop({ t: 10 });
    const stopped = performance.now();
    await json(`${manifest.bnClock}/advance/${nowMs}`, { method: "POST" });
    if (manifest.bake.recipe.preparedSkip) {
      const slot = Math.floor((nowMs / 1000 - manifest.config.genesisTime) / 12);
      await waitFor(`prepared empty-slot state at slot ${slot}`, async () => {
        const clock = await json<{ marks: Record<string, number> }>(manifest.bnClock);
        return clock.marks.skip_ready === slot ? true : undefined;
      });
    }
    const prepared = performance.now();
    await old.remove();
    const { startMs } = clockEnvironment(manifest.bake.recipe);
    const env = (info.Config.Env ?? []).filter((e) =>
      !e.startsWith(`${startMs}=`) && !e.startsWith("PANDA_CLOCK_PARKED=")
    );
    const replacement = await this.infra.container("vc", {
      Image: info.Image,
      User: info.Config.User,
      Entrypoint: info.Config.Entrypoint,
      Cmd: info.Config.Cmd?.filter((arg) => arg !== "--init-slashing-protection"),
      Env: [...env, `${startMs}=${nowMs}`],
      ExposedPorts: info.Config.ExposedPorts,
      HostConfig: {
        ...info.HostConfig,
        PortBindings: Object.fromEntries(
          Object.keys(info.Config.ExposedPorts ?? {}).map((
            key,
          ) => [key, [{ HostIp: "127.0.0.1", HostPort: "" }]]),
        ),
      },
    });
    await replacement.start();
    const ports = (await replacement.inspect()).NetworkSettings.Ports;
    manifest.vcClock = `http://127.0.0.1:${ports["5059/tcp"]![0].HostPort}`;
    manifest.vc = `http://127.0.0.1:${ports["5062/tcp"]![0].HostPort}`;
    await durableJson(`${this.store.root}/manifest.json`, manifest);
    await waitFor("validator restarted after skipped slots", async () => {
      const clock = await json<{ nowMs: number; marks: Record<string, number> }>(manifest.vcClock);
      return clock.nowMs === nowMs && clock.marks.ready === 0 && clock.marks.indices !== undefined
        ? true
        : undefined;
    });
    console.log(JSON.stringify({
      event: "slots-skipped",
      id: this.config.id,
      nowMs,
      stopMs: stopped - started,
      prepareMs: prepared - stopped,
      restartMs: performance.now() - prepared,
      elapsedMs: performance.now() - started,
    }));
  }
  async stop(): Promise<void> {
    if (!this.lockOwned) {
      await this.store.initialize();
      this.lock = await StateLock.acquire(`${this.store.root}/network.lock`);
    }
    try {
      const active = await this.store.active();
      if (active) {
        this.generation = active;
        this.infra.useGeneration(active.generation);
      }
      try {
        await this.saveLogs();
      } finally {
        try {
          await this.engine?.close();
        } finally {
          await this.infra.cleanup();
          if (active) {
            await this.store.destroy(active);
            this.generation = undefined;
          }
        }
      }
    } finally {
      await this.releaseLock();
    }
  }
  static async manifest(id = "local"): Promise<Manifest> {
    configuration({ id });
    return JSON.parse(await Deno.readTextFile(`${stateDirectory(id)}/manifest.json`));
  }
}
