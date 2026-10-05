import { type Bake, clockEnvironment, readBake } from "./profiles.ts";
import { requireImage } from "./artifacts.ts";
import { account, type Config, configuration, mnemonic } from "./config.ts";
import { Infrastructure, LABEL, ROLE } from "./docker.ts";
import { checkEngineCapabilities, EngineGate } from "./engine.ts";
import { deadline, defaultTimeoutMs, json, rpc, waitFor } from "./http.ts";
import { BeaconRelay } from "./beacon_relay.ts";
import { ConsensusMessages } from "./consensus_messages.ts";
import { needsPtcReadiness, PtcReadiness } from "./ptc_readiness.ts";

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
}
export class Network {
  engine?: EngineGate;
  beaconRelay?: BeaconRelay;
  ptcReadiness?: PtcReadiness;
  readonly consensusMessages?: ConsensusMessages;
  private lockOwned = false;
  readonly infra: Infrastructure;
  readonly directory: string;
  constructor(readonly config: Config) {
    this.infra = new Infrastructure(config.id);
    this.directory = `${Deno.cwd()}/.panda/${config.id}`;
    if (config.profile === "gloas" && config.mode === "controlled") {
      this.consensusMessages = new ConsensusMessages(() =>
        Math.floor(
          ((this.engine?.nowMs ?? config.genesisTime * 1000) / 1000 - config.genesisTime) / 12,
        )
      );
    }
  }
  async start(): Promise<Manifest> {
    await Deno.mkdir(this.directory, { recursive: true });
    const path = `${this.directory}/network.lock`;
    try {
      const lock = await Deno.open(path, { createNew: true, write: true });
      try {
        await lock.write(new TextEncoder().encode(String(Deno.pid)));
      } finally {
        lock.close();
      }
      this.lockOwned = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      const pid = Number(await Deno.readTextFile(path));
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("Network lock is incomplete; retry");
      }
      try {
        Deno.kill(pid, 0);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await Deno.remove(path);
        return await this.start();
      }
      throw new Error(`Devnet ${this.config.id} is owned by live process ${pid}`);
    }
    try {
      return await this.startOwned();
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }
  private async releaseLock(): Promise<void> {
    if (this.lockOwned) {
      await Deno.remove(`${this.directory}/network.lock`);
      this.lockOwned = false;
    }
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
  private async startOwned(): Promise<Manifest> {
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
    await Deno.mkdir(this.directory, { recursive: true });
    const { config, infra, directory } = this;
    // Bind-mounted metadata, keys and the private VC token must belong to the controller.
    const sharedUser = `${Deno.uid()}:${Deno.gid()}`;
    for (const name of ["metadata", "parsed", "jwt", "validator-keys", "manifest.json"]) {
      try {
        await Deno.remove(`${directory}/${name}`, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    const bake = await readBake(config.profile, config.bake);
    const recipe = bake.recipe;
    const ptcReadiness = config.profile === "gloas" && config.mode === "controlled" &&
      recipe.ptcReadiness === true;
    if (ptcReadiness) this.ptcReadiness = new PtcReadiness();
    const clockEnv = config.mode === "controlled"
      ? [
        `${clockEnvironment(recipe).startMs}=${config.genesisTime * 1000 + 11_500}`,
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
      const network = await infra.network();
      const data = await infra.volume("el");
      const beaconData = await infra.volume("bn");
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
        Cmd: ["--datadir=/el", "init", "/shared/metadata/genesis.json"],
        HostConfig: { Binds: [`${directory}:/shared:ro`, `${data}:/el`], NetworkMode: network },
      });
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
          config.genesisTime * 1000 + 11_500,
          await Deno.readTextFile(`${directory}/jwt/jwtsecret`),
        );
      }
      const bn = await start("bn", {
        Image: clientImage,
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
          "--init-slashing-protection",
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
          ExtraHosts: Deno.build.os === "linux" ? ["host.docker.internal:host-gateway"] : undefined,
        },
      });
      const manifest: Manifest = {
        bake,
        config,
        directory,
        el: el(8545),
        beacon: bn(5052),
        bnClock: bn(5059),
        vcClock: vc(5059),
        vc: vc(5062),
        ...(ptcReadiness ? { vcMetrics: vc(5064) } : {}),
      };
      this.bindValidator(manifest);
      if (config.mode === "controlled") {
        await waitFor("validator clock and services", async () => {
          const clock = await json<{ marks: Record<string, number> }>(vc(5059));
          return clock.marks.ready === 0 && clock.marks.indices === 0 ? clock : undefined;
        });
      }
      await this.ptcReadiness?.beforeDuties();
      await Deno.writeTextFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
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
      this.ptcReadiness?.close();
      const errors = [error];
      try {
        await this.beaconRelay?.close();
      } catch (relay) {
        errors.push(relay);
      }
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
      throw errors.length === 1 ? error : new AggregateError(errors, "Startup failed");
    }
  }
  async saveLogs(): Promise<void> {
    await Deno.mkdir(this.directory, { recursive: true });
    const containers = await this.infra.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL}=${this.config.id}`] },
    });
    for (const c of containers) {
      await Deno.writeTextFile(
        `${this.directory}/${c.Labels[ROLE]}.log`,
        await this.infra.logs(this.infra.docker.getContainer(c.Id)),
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
    await Deno.writeTextFile(`${this.directory}/manifest.json`, JSON.stringify(manifest, null, 2));
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
    if (!this.lockOwned) {
      try {
        const pid = Number(await Deno.readTextFile(`${this.directory}/network.lock`));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Network is starting; retry");
        Deno.kill(pid, 0);
        throw new Error(`Devnet is owned by live process ${pid}; use its controller to shut down`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    try {
      await this.saveLogs();
    } finally {
      this.ptcReadiness?.close();
      try {
        try {
          await this.beaconRelay?.close();
        } finally {
          await this.engine?.close();
        }
      } finally {
        try {
          await this.infra.cleanup();
        } finally {
          await this.releaseLock();
        }
      }
    }
  }
  static async manifest(id = "local"): Promise<Manifest> {
    configuration({ id });
    return JSON.parse(await Deno.readTextFile(`.panda/${id}/manifest.json`));
  }
}
