import { type Bake, canonical, clockEnvironment, readBake } from "./profiles.ts";
import { requireImage } from "./artifacts.ts";
import { account, type Config, configuration, mnemonic } from "./config.ts";
import { GENERATION, Infrastructure, LABEL, ROLE } from "./docker.ts";
import { checkEngineCapabilities, EngineGate } from "./engine.ts";
import { deadline, defaultTimeoutMs, json, rpc, waitFor } from "./http.ts";
import { BeaconRelay } from "./beacon_relay.ts";
import { ConsensusMessages, replayConsensusMessages } from "./consensus_messages.ts";
import { needsPtcReadiness, PtcReadiness } from "./ptc_readiness.ts";

import { SnapshotJournal, type SnapshotOperation } from "./snapshot_operations.ts";
import { SnapshotStore } from "./snapshots.ts";
import {
  type ActiveGeneration,
  durableJson,
  fileInventory,
  stateDirectory,
  StateLock,
  StateStore,
} from "./storage.ts";
import type { CapturedState, SavedState } from "./snapshot_types.ts";
import { validateSavedState } from "./saved_state.ts";

export interface Manifest {
  bake: Bake;
  config: Config;
  el: string;
  beacon: string;
  bnClock: string;
  vcClock: string;
  vc: string;
  vcMetrics?: string;
  directory: string;
  generation?: string;
}
export class Network {
  engine?: EngineGate;
  beaconRelay?: BeaconRelay;
  ptcReadiness?: PtcReadiness;
  readonly consensusMessages?: ConsensusMessages;
  private lock?: StateLock;
  private candidate?: { sourceGeneration?: string; manifest?: Manifest };
  private recovery = false;
  private runtimeManifest?: Manifest;
  private validatorStart?: () => Promise<void>;
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
    if (config.profile === "gloas" && config.mode === "controlled") {
      this.consensusMessages = new ConsensusMessages(() =>
        Math.floor(
          ((this.engine?.nowMs ?? this.generation?.checkpoint?.nowMs ?? config.genesisTime * 1000) /
              1000 - config.genesisTime) / 12,
        )
      );
    }
  }
  async enterRecovery(): Promise<Bake> {
    if (this.lockOwned) throw new Error("Network ownership is already held");
    await this.store.initialize();
    this.lock = await StateLock.acquire(`${this.store.root}/network.lock`);
    try {
      const active = await this.store.active();
      if (active && canonical(active.config) !== canonical(this.config)) {
        throw new Error("Recovery configuration mismatch");
      }
      const bake = await readBake(this.config.profile, this.config.bake);
      if (
        this.config.profile !== "gloas" || this.config.mode !== "controlled" ||
        !bake.recipe.ptcReadiness || active && active.bakeKey !== bake.key
      ) throw new Error("Recovery requires the exact snapshot-capable bake");
      this.generation = active;
      if (active) this.infra.useGeneration(active.generation);
      this.recovery = true;
      return bake;
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }
  releaseRecovery(): void {
    if (!this.recovery && this.lockOwned) throw new Error("Network is not in recovery mode");
    this.releaseLock();
  }
  async cleanupSnapshotData(records: SnapshotOperation[]): Promise<void> {
    const owned = this.lockOwned;
    if (!owned) this.lock = await StateLock.acquire(`${this.store.root}/network.lock`);
    try {
      await new SnapshotStore(this.store, this.infra).cleanup(records);
    } finally {
      if (!owned) this.releaseLock();
    }
  }
  async startCandidate(value: ActiveGeneration): Promise<Manifest> {
    if (this.generation || this.lockOwned || this.candidate) {
      throw new Error("Candidate requires an unused Network instance");
    }
    this.candidate = {};
    this.generation = value;
    this.infra.useGeneration(value.generation);
    return await this.start("resume");
  }
  async commitCandidate(): Promise<void> {
    if (!this.lockOwned || !this.candidate?.manifest || !this.generation) {
      throw new Error("No started candidate to commit");
    }
    if ((await this.store.active())?.generation !== this.candidate.sourceGeneration) {
      throw new Error("Active generation changed before candidate commit");
    }
    try {
      await this.store.write(this.generation);
    } finally {
      // A rename can win even if its acknowledgement/fsync fails. Never roll authority back.
      if ((await this.store.active())?.generation === this.generation.generation) {
        this.candidate = undefined;
      }
    }
    await durableJson(`${this.store.root}/manifest.json`, this.runtimeManifest);
  }
  async start(mode: "new" | "resume" | "auto" = "new"): Promise<Manifest> {
    await this.store.initialize();
    this.lock = await StateLock.acquire(`${this.store.root}/network.lock`);
    try {
      return await this.startOwned(mode);
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }
  private releaseLock(): void {
    this.lock?.release();
    this.lock = undefined;
  }
  async activateValidator(): Promise<void> {
    if (this.candidate) throw new Error("Commit candidate before starting its validator");
    if (!this.lockOwned || !this.validatorStart || !this.runtimeManifest) {
      throw new Error("No prepared validator runtime");
    }
    const start = this.validatorStart;
    this.validatorStart = undefined;
    await start();
    await this.setPhase("running");
    await durableJson(`${this.store.root}/manifest.json`, this.runtimeManifest);
  }
  /** Call after stopping the old VC and before starting its replacement. */
  prepareValidator(): void {
    this.ptcReadiness?.reset();
  }
  /** Bind newly discovered private endpoints before waiting for replacement readiness. */
  bindValidator(manifest: Manifest): void {
    if (this.beaconRelay) this.beaconRelay.upstream = manifest.beacon;
    if (needsPtcReadiness(manifest)) {
      if (!this.ptcReadiness) throw new Error("Missing validator PTC bootstrap runtime");
      this.ptcReadiness.bind(manifest);
    }
  }
  private async startOwned(mode: "new" | "resume" | "auto"): Promise<Manifest> {
    const active = await this.store.active();
    const resume = mode === "resume" || mode === "auto" && active !== undefined;
    if (resume) {
      if (this.candidate) {
        if (active?.generation === this.generation!.generation) {
          throw new Error("Candidate must be inactive");
        }
        this.candidate.sourceGeneration = active?.generation;
        this.generation = await this.store.validateCheckpoint(this.generation!);
      } else this.generation = await this.store.resumable();
      if (canonical(this.generation.config) !== canonical(this.config)) {
        throw new Error("Preserved generation configuration mismatch");
      }
    } else if (active) throw new Error("Active generation exists; resume it or use down/reset");
    const filters = { label: [`${LABEL}=${this.config.id}`] };
    const [existing, networks, volumes] = await Promise.all([
      this.infra.docker.listContainers({ all: true, filters }),
      this.infra.docker.listNetworks({ filters }),
      this.infra.docker.listVolumes({ filters }),
    ]);
    if (existing.length || networks.length || volumes.Volumes?.length) {
      throw new Error(
        `Devnet ${this.config.id} already has resources; use down/reset or connect()`,
      );
    }
    const { config, infra } = this;
    const sharedUser = `${Deno.uid()}:${Deno.gid()}`;
    const bake = await readBake(config.profile, config.bake);
    if (resume && (bake.key !== this.generation!.bakeKey || !bake.recipe.ptcReadiness)) {
      throw new Error("Preserved generation requires its exact snapshot-capable bake");
    }
    const recipe = bake.recipe;
    const startMs = resume
      ? this.generation!.checkpoint!.nowMs
      : config.genesisTime * 1000 + 11_500;
    const ptcReadiness = config.profile === "gloas" && config.mode === "controlled" &&
      recipe.ptcReadiness === true;
    if (ptcReadiness) this.ptcReadiness = new PtcReadiness();
    const clockEnv = config.mode === "controlled"
      ? [
        `${clockEnvironment(recipe).startMs}=${startMs}`,
        `${clockEnvironment(recipe).port}=5059`,
      ]
      : [];
    const images = {
      geth: await requireImage(infra, bake.images.el),
      genesis: await requireImage(infra, bake.images.genesis),
    };
    const clientImage = await requireImage(
      infra,
      config.mode === "controlled" ? bake.images.cl : bake.images.baseline,
    );
    const started = performance.now();
    try {
      this.generation ??= await this.store.create(config, bake.key);
      infra.useGeneration(this.generation.generation);
      const generationPath = await this.store.validate(this.generation);
      const directory = this.directory;
      await this.setPhase("starting");
      if (resume) {
        const saved = this.generation.checkpoint!;
        if (
          canonical(await this.sharedInventory()) !== canonical(saved.sharedFiles) ||
          canonical(await this.databaseInventory()) !== canonical(saved.databaseFiles)
        ) throw new Error("Preserved database or signing files changed");
        await this.validateValidatorData();
      }
      const network = await infra.network();
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
        const c = await infra.container(role, options);
        await c.start();
        const result = await deadline(c.wait(), defaultTimeoutMs(), `${role} container`);
        const logs = await infra.logs(c);
        await Deno.writeTextFile(`${directory}/${role}.log`, logs);
        if (result.StatusCode !== 0) throw new Error(`${role} failed: ${logs}`);
        await c.remove({ v: true });
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
        const container = await infra.container(role, options);
        await container.start();
        const info = await container.inspect();
        return (p: number) =>
          `http://127.0.0.1:${info.NetworkSettings.Ports[`${p}/tcp`]?.[0]?.HostPort}`;
      };
      const el = await start("el", {
        Image: images.geth,
        User: sharedUser,
        Cmd: [
          "--datadir=/el",
          "--ipcdisable",
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
      await waitFor("Geth RPC", () => rpc(el(8545), "eth_chainId"));
      await checkEngineCapabilities(
        el(8551),
        await Deno.readTextFile(`${directory}/jwt/jwtsecret`),
        recipe.engineMethods,
      );
      if (config.mode === "controlled") {
        this.engine = await EngineGate.start(
          infra,
          infra.docker.getContainer(`panda-${config.id}-el`),
          el(8551),
          startMs,
          await Deno.readTextFile(`${directory}/jwt/jwtsecret`),
        );
      }
      const bn = await start("bn", {
        Image: clientImage,
        User: sharedUser,
        Entrypoint: ["lighthouse"],
        Env: clockEnv,
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
      await waitFor("Beacon API", () => json(`${bn(5052)}/eth/v1/beacon/genesis`));
      if (this.consensusMessages) {
        this.beaconRelay = new BeaconRelay(bn(5052), this.consensusMessages, this.ptcReadiness);
      }
      const manifest: Manifest = {
        bake,
        config,
        directory,
        generation: this.generation.generation,
        el: el(8545),
        beacon: bn(5052),
        bnClock: bn(5059),
        vcClock: "",
        vc: "",
      };
      this.runtimeManifest = manifest;
      if (resume) {
        const saved = this.generation.checkpoint!;
        await waitFor("restored execution connection", async () => {
          const { data } = await json<
            { data: { is_syncing: boolean; is_optimistic: boolean; el_offline: boolean } }
          >(`${manifest.beacon}/eth/v1/node/syncing`);
          return data.is_syncing === false && data.is_optimistic === false &&
              data.el_offline === false
            ? true
            : undefined;
        });
        this.consensusMessages!.restore(saved.replayMessages);
        await replayConsensusMessages(saved.replayMessages, manifest.beacon, saved.slot);
        await validateSavedState(manifest, saved);
      }
      this.validatorStart = async () => {
        this.prepareValidator();
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
            `--beacon-nodes=${this.beaconRelay?.url ?? "http://bn:5052"}`,
            ...(config.profile === "gloas" && config.mode === "controlled" && !recipe.preparedSkip
              ? ["--use-long-timeouts", "--long-timeouts-multiplier=60"]
              : []),
            ...(!resume ? ["--init-slashing-protection"] : []),
            `--suggested-fee-recipient=${account}`,
            "--http",
            "--http-address=0.0.0.0",
            "--unencrypted-http-transport",
            ...(ptcReadiness
              ? ["--disable-payload-available-monitor", "--metrics", "--metrics-address=0.0.0.0"]
              : []),
          ],
          ExposedPorts: {
            "5062/tcp": {},
            "5059/tcp": {},
            ...(ptcReadiness ? { "5064/tcp": {} } : {}),
          },
          HostConfig: {
            Binds: [`${directory}:/shared`],
            NetworkMode: network,
            PortBindings: {
              ...port("5062/tcp"),
              ...port("5059/tcp"),
              ...(ptcReadiness ? port("5064/tcp") : {}),
            },
            MemoryReservation: 128 * 1024 ** 2,
            NanoCpus: 2e9,
            ExtraHosts: Deno.build.os === "linux"
              ? ["host.docker.internal:host-gateway"]
              : undefined,
          },
        });
        manifest.vcClock = vc(5059);
        manifest.vc = vc(5062);
        if (ptcReadiness) manifest.vcMetrics = vc(5064);
        this.bindValidator(manifest);
        if (config.mode === "controlled") {
          await waitFor("validator clock and services", async () => {
            const clock = await json<{ marks: Record<string, number> }>(vc(5059));
            return clock.marks.ready === 0 &&
                clock.marks.indices === Math.floor((startMs / 1000 - config.genesisTime) / 12)
              ? clock
              : undefined;
          });
        }
        await this.ptcReadiness?.beforeDuties();
      };
      if (this.candidate) this.candidate.manifest = manifest;
      else await this.activateValidator();
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
      await this.fail(error);
      throw error;
    }
  }
  private async closeRuntime(): Promise<void> {
    this.ptcReadiness?.close();
    try {
      await this.beaconRelay?.close();
    } finally {
      await this.engine?.close();
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
    checkpoint?: SavedState,
    error?: string,
  ): Promise<void> {
    if (!this.generation) throw new Error("No active generation");
    const next = {
      ...this.generation,
      phase,
      checkpoint: checkpoint ?? this.generation.checkpoint,
      error,
    };
    if (this.candidate) {
      if (phase === "running") throw new Error("Candidate must be committed before running");
    } else await this.store.write(next);
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
  private async sharedInventory(): Promise<SavedState["sharedFiles"]> {
    const result = {} as SavedState["sharedFiles"];
    for (const name of ["metadata", "jwt", "validator-keys"] as const) {
      result[name] = await fileInventory(`${this.directory}/${name}`);
    }
    return result;
  }
  private async databaseInventory(): Promise<SavedState["databaseFiles"]> {
    const path = this.store.generationPath(this.generation!.generation);
    return {
      el: await fileInventory(`${path}/el`),
      bn: await fileInventory(`${path}/bn`),
    };
  }
  async preserve(checkpoint: CapturedState, timeoutMs = defaultTimeoutMs()): Promise<void> {
    if (this.candidate) throw new Error("Candidate must be committed before preserve");
    if (!this.lockOwned || !this.generation) {
      throw new Error("Network is not owned by this controller");
    }
    await this.validateValidatorData();
    await this.setPhase("stopping");
    try {
      let replayMessages = checkpoint.replayMessages;
      await this.infra.stopClients(timeoutMs, async () => {
        await this.consensusMessages?.idle();
        const messages = this.consensusMessages?.snapshot();
        if (!messages) throw new Error("Missing consensus capture");
        replayMessages = messages;
      });
      await this.validateValidatorData();
      await this.saveLogs();
      await this.closeRuntime();
      await this.infra.cleanup();
      await this.setPhase("stopped", {
        ...checkpoint,
        replayMessages,
        sharedFiles: await this.sharedInventory(),
        databaseFiles: await this.databaseInventory(),
      });
      await this.releaseLock();
    } catch (error) {
      await this.setPhase("faulted", undefined, String(error));
      throw error;
    }
  }
  /** Failed resume retains evidence and data; it must never silently become a fresh network. */
  async fail(error: unknown, scope: "generation" | "network" = "generation"): Promise<void> {
    const errors: unknown[] = [];
    try {
      for (
        const cleanup of [
          () =>
            this.generation
              ? this.setPhase("faulted", undefined, String(error))
              : Promise.resolve(),
          () => this.saveLogs(),
          () => this.closeRuntime(),
          () => this.infra.cleanup(scope),
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
  /** Explicit restore abandons the authoritative runtime but retains its files as evidence. */
  async discard(): Promise<void> {
    if (!this.lockOwned) {
      await this.store.initialize();
      this.lock = await StateLock.acquire(`${this.store.root}/network.lock`);
    }
    try {
      const active = await this.store.active();
      this.generation = active;
      if (active) this.infra.useGeneration(active.generation);
      // A killed pre-commit controller can leave clients for an inactive candidate. The owner
      // lock excludes another live controller; explicit restore abandons every runtime of this id.
      await this.fail(new Error("Branch discarded by explicit snapshot restore"), "network");
    } finally {
      this.releaseLock();
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
    await old.stop({ t: 10 });
    this.prepareValidator();
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
    const env = (info.Config.Env ?? []).filter((e) => !e.startsWith(`${startMs}=`));
    const replacement = await this.infra.container("vc", {
      Image: info.Image,
      User: info.Config.User,
      Entrypoint: info.Config.Entrypoint,
      Cmd: info.Config.Cmd,
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
    if (needsPtcReadiness(manifest)) {
      manifest.vcMetrics = `http://127.0.0.1:${ports["5064/tcp"]![0].HostPort}`;
    }
    this.bindValidator(manifest);
    await durableJson(`${this.store.root}/manifest.json`, manifest);
    await waitFor("validator restarted after skipped slots", async () => {
      const clock = await json<{ nowMs: number; marks: Record<string, number> }>(manifest.vcClock);
      return clock.nowMs === nowMs && clock.marks.ready === 0 && clock.marks.indices !== undefined
        ? true
        : undefined;
    });
    await this.ptcReadiness?.beforeDuties();
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
    if (this.candidate) {
      // Candidate cleanup owns only its own clients and keeps both database generations.
      if (this.lockOwned) await this.fail(new Error("Restore candidate abandoned"));
      return;
    }
    if (!this.lockOwned) {
      await this.store.initialize();
      this.lock = await StateLock.acquire(`${this.store.root}/network.lock`);
    }
    let journalLock: StateLock | undefined;
    try {
      // A capture temporarily releases the network lock after clean stop. Its journal still owns
      // the source until copying/resume finishes; refuse down before touching any of that data.
      journalLock = await StateLock.acquire(`${this.store.root}/snapshot-operation.lock`);
      const active = await this.store.active();
      if (active) {
        this.generation = active;
        this.infra.useGeneration(active.generation);
      }
      try {
        await this.saveLogs();
      } finally {
        try {
          await this.closeRuntime();
        } finally {
          await this.infra.cleanup("network");
          if (active) {
            await this.store.destroy(active);
            this.generation = undefined;
          }
          await this.cleanupSnapshotData(await new SnapshotJournal(this.store).list());
        }
      }
    } finally {
      journalLock?.release();
      await this.releaseLock();
    }
  }
  static async manifest(id = "local"): Promise<Manifest> {
    configuration({ id });
    return JSON.parse(await Deno.readTextFile(`${stateDirectory(id)}/manifest.json`));
  }
}
