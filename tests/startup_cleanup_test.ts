/** A failed fresh start must not leave state that forces recovery (regression from main). */
import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { Consensus } from "../src/consensus.ts";
import { Controller } from "../src/controller.ts";
import type { Infrastructure } from "../src/docker.ts";
import { type Manifest, Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
import { type ActiveGeneration, StateStore } from "../src/storage.ts";

async function isolated(run: () => Promise<void>) {
  const base = await Deno.makeTempDir({ prefix: "startup-cleanup-" });
  const prior = Deno.env.get("PANDA_DATA_DIR");
  Deno.env.set("PANDA_DATA_DIR", base);
  try {
    await run();
  } finally {
    if (prior === undefined) Deno.env.delete("PANDA_DATA_DIR");
    else Deno.env.set("PANDA_DATA_DIR", prior);
    await Deno.remove(base, { recursive: true });
  }
}

/** Docker calls succeed without resources; only the selected step fails. */
function offline(infra: Infrastructure, failNetwork: boolean) {
  const docker = infra.docker as unknown as Record<string, unknown>;
  docker.listContainers = () => Promise.resolve([]);
  docker.listNetworks = () => Promise.resolve([]);
  docker.listVolumes = () => Promise.resolve({ Volumes: [] });
  docker.getImage = (id: string) => ({ inspect: () => Promise.resolve({ Id: id }) });
  infra.cacheImage = () => Promise.resolve();
  infra.cleanup = () => Promise.resolve();
  infra.assertGenerationUnused = () => Promise.resolve();
  if (failNetwork) infra.network = () => Promise.reject(new Error("network create failed"));
}

for (const profile of ["pectra", "gloas"] as const) {
  Deno.test(`${profile}: a failed fresh start leaves no active generation`, async () => {
    await isolated(async () => {
      const config = configuration({
        id: `failed-start-${profile}`,
        profile,
        bake: profile === "gloas" ? "snapshot-minimal-r1" : "ci-main-merge",
      });
      const network = new Network(config);
      offline(network.infra, true);
      await assert.rejects(network.start(), /network create failed/);
      assert.equal(await network.store.active(), undefined, "failed genesis requires recovery");
      // The next ordinary start is fresh rather than "Active generation exists".
      const next = new Network(config);
      offline(next.infra, true);
      await assert.rejects(next.start(), /network create failed/);
    });
  });
}

Deno.test("a fresh controller start that fails after client startup leaves no active generation", async () => {
  await isolated(async () => {
    const config = configuration({
      id: "failed-connect",
      profile: "pectra",
      bake: "ci-main-merge",
    });
    const bake = await readBake(config.profile, config.bake);
    const start = Network.prototype.start;
    const connect = Consensus.connect;
    Network.prototype.start = async function () {
      offline(this.infra, false);
      await this.store.initialize();
      this.generation = await this.store.create(this.config, bake.key);
      await this.setPhase("running");
      return { config, bake } as Manifest;
    };
    Consensus.connect = () => Promise.reject(new Error("consensus connect failed"));
    try {
      await assert.rejects(Controller.start(config), /consensus connect failed/);
      assert.equal(await new Network(config).store.active(), undefined);
    } finally {
      Network.prototype.start = start;
      Consensus.connect = connect;
    }
  });
});

function recoveryController(fail: () => Promise<void> = () => Promise.resolve()) {
  const config = configuration({
    id: "close-order",
    profile: "gloas",
    bake: "snapshot-minimal-r1",
  });
  return readBake(config.profile, config.bake).then((bake) => {
    const network = new Network(config);
    network.fail = fail;
    return { controller: new Controller(network, bake), network };
  });
}
async function recordingStops(run: (events: string[]) => Promise<void>) {
  const events: string[] = [];
  const stop = Network.prototype.stop;
  Network.prototype.stop = function () {
    events.push(this.restoring ? "stop:candidate" : "stop:active");
    return Promise.resolve();
  };
  try {
    await run(events);
  } finally {
    Network.prototype.stop = stop;
  }
}

Deno.test("down during a preserving shutdown still removes the active network", async () => {
  await recordingStops(async (events) => {
    const gate = Promise.withResolvers<void>();
    const { controller } = await recoveryController(async () => {
      events.push("preserve");
      await gate.promise;
    });
    const preserving = controller.closePreserving();
    const down = controller.close();
    gate.resolve();
    await preserving;
    await down;
    assert.deepEqual(events, ["preserve", "stop:active"]);
  });
});

Deno.test("closing an abandoned restore candidate also removes the active network", async () => {
  await recordingStops(async (events) => {
    const { controller, network } = await recoveryController();
    (network as unknown as { candidate: object }).candidate = {};
    await controller.close();
    assert.deepEqual(events, ["stop:candidate", "stop:active"]);
  });
});

Deno.test("a failed server shutdown still removes the network and releases ownership", async () => {
  await recordingStops(async (events) => {
    const { controller } = await recoveryController();
    controller.server = {
      shutdown: () => Promise.reject(new Error("server shutdown failed")),
    } as unknown as Deno.HttpServer<Deno.NetAddr>;
    await assert.rejects(controller.close(), /server shutdown failed/);
    assert.deepEqual(events, ["stop:active"]);
  });
});

Deno.test("startup selection prefers retained configuration over defaults and seeds", async (t) => {
  const calls: unknown[][] = [];
  const original = {
    start: Controller.start,
    recover: Controller.recover,
    fromSnapshot: Controller.fromSnapshot,
    active: StateStore.prototype.active,
  };
  const retainedConfig = configuration({
    id: "service",
    profile: "gloas",
    bake: "snapshot-minimal-r1",
    validators: 72,
    chainId: 7777,
  });
  let retained: ActiveGeneration | undefined;
  StateStore.prototype.active = () => Promise.resolve(retained);
  Controller.start = (
    ...args
  ) => (calls.push(["start", ...args]), Promise.resolve({} as Controller));
  Controller.recover = (
    ...args
  ) => (calls.push(["recover", ...args]), Promise.resolve({} as Controller));
  Controller.fromSnapshot = (...args) => (
    calls.push(["fromSnapshot", ...args]), Promise.resolve({} as Controller)
  );
  const input = { id: "service", profile: "gloas", bake: "snapshot-minimal-r1" } as const;
  const seed = { source: "https://example.org/seed.panda.gz", sha256: "ab".repeat(32) };
  try {
    for (
      const [name, phase, expected] of [
        ["stopped resumes its own configuration", "stopped", ["start", retainedConfig, "resume"]],
        ["unclean enters recovery with its own configuration", "faulted", [
          "recover",
          retainedConfig,
        ]],
      ] as const
    ) {
      await t.step(name, async () => {
        calls.length = 0;
        retained = { phase, config: retainedConfig } as ActiveGeneration;
        await Controller.launch(input, seed);
        assert.deepEqual(calls, [expected], "retained state lost to defaults or the seed");
      });
    }
    await t.step("an absent generation imports the seed", async () => {
      calls.length = 0;
      retained = undefined;
      await Controller.launch(input, seed);
      assert.deepEqual(calls, [["fromSnapshot", seed.source, input, { sha256: seed.sha256 }]]);
    });
    await t.step("an explicit different bake is refused", async () => {
      retained = { phase: "stopped", config: retainedConfig } as ActiveGeneration;
      await assert.rejects(Controller.launch({ ...input, bake: "other" }), /differs from retained/);
    });
  } finally {
    Object.assign(Controller, {
      start: original.start,
      recover: original.recover,
      fromSnapshot: original.fromSnapshot,
    });
    StateStore.prototype.active = original.active;
  }
});

Deno.test("taking controller ownership removes abandoned archive transfers", async () => {
  await isolated(async () => {
    const config = configuration({ id: "sweep", profile: "gloas", bake: "snapshot-minimal-r1" });
    const store = new StateStore(config.id);
    await store.initialize();
    const leftover = `${await store.snapshotsDirectory()}/.pending-export-killed`;
    await Deno.mkdir(leftover);
    await Deno.writeTextFile(`${leftover}/snapshot.gz`, "validator keys");
    const controller = await Controller.recover(config);
    try {
      await assert.rejects(Deno.lstat(leftover), Deno.errors.NotFound);
    } finally {
      controller.network.fail = () => Promise.resolve();
      await controller.closePreserving();
    }
  });
});
