import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { dockerClient, Infrastructure, LABEL, ROLE } from "../src/docker.ts";
import { Network } from "../src/network.ts";
import { clockEnvironment, profiles } from "../src/profiles.ts";

function withEnv(values: Record<string, string | undefined>, check: () => void): void {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, Deno.env.get(name)]),
  );
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    check();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("local runs default to Gloas while Pectra is paused", () => {
  withEnv({ PANDA_PROFILE: undefined }, () => assert.equal(configuration().profile, "gloas"));
});

Deno.test("Panda environment selects the hardfork and bake; explicit options take precedence", () => {
  withEnv({ PANDA_PROFILE: "gloas", PANDA_BAKE: "candidate" }, () => {
    assert.equal(configuration().profile, "gloas");
    assert.equal(configuration().bake, "candidate");
    assert.equal(configuration({ profile: "pectra", bake: "local" }).profile, "pectra");
    assert.equal(configuration({ profile: "pectra", bake: "local" }).bake, "local");
  });
});

Deno.test("clock launch and restart select the environment compiled into each bake", () => {
  for (const recipe of Object.values(profiles)) {
    assert.deepEqual(clockEnvironment(recipe), {
      startMs: "PANDA_CLOCK_START_MS",
      port: "PANDA_CLOCK_PORT",
    });
    const archivedRecipe = { ...recipe, clockEnvPrefix: undefined };
    assert.throws(
      () => clockEnvironment(archivedRecipe),
      /Missing clock environment namespace.*deno task bake/,
    );
    assert.throws(() => clockEnvironment({ ...recipe, clockEnvPrefix: "" }));
    assert.throws(() => clockEnvironment({ ...recipe, clockEnvPrefix: "bad=name" }));
  }
});

Deno.test("Panda Docker socket overrides DOCKER_HOST without allowing a remote daemon", () => {
  for (const host of ["tcp://remote:2375", "tcp://remote:2376"]) {
    withEnv({ PANDA_DOCKER_SOCKET: "/tmp/panda-test.sock", DOCKER_HOST: host }, () => {
      const client = dockerClient();
      assert.equal(Reflect.get(client.modem, "socketPath"), "/tmp/panda-test.sock");
      assert.equal(Reflect.get(client.modem, "host"), undefined);
      assert.equal(Reflect.get(client.modem, "protocol"), "http");
    });
  }
});

Deno.test("Panda state and Docker ownership use the project namespace", () => {
  const id = "namespace-test";
  assert.equal(new Network(configuration({ id })).directory, `${Deno.cwd()}/.panda/${id}`);
  assert.equal(LABEL, "io.panda.id");
  assert.equal(ROLE, "io.panda.role");
  assert.deepEqual(new Infrastructure(id).labels, { "io.panda.id": id });
});
