import assert from "node:assert/strict";
import { configuration } from "../src/config.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { Network } from "../src/network.ts";

Deno.test({
  name: "partial startup rollback preserves another stand and is repeatable",
  ignore: Deno.env.get("PANDA_DOCKER_TEST") !== "1",
  fn: async () => {
    const id = `rollback-${crypto.randomUUID().slice(0, 8)}`;
    const infra = new Infrastructure(id);
    const foreign = new Infrastructure(`other-${crypto.randomUUID().slice(0, 8)}`);
    const collision = `panda-${id}`;
    assert.deepEqual(infra.labels, { "io.panda.id": id });
    await foreign.docker.createNetwork({
      Name: collision,
      Labels: foreign.labels,
      Driver: "bridge",
    });
    try {
      const network = new Network(configuration({ id }));
      await assert.rejects(network.start(), /already exists/);
      await network.stop();
      await infra.cleanup();
      await infra.cleanup();
      assert.equal(
        (await infra.docker.listNetworks({ filters: { label: [`${LABEL}=${id}`] } })).length,
        0,
      );
      assert.equal(
        (await infra.docker.listVolumes({ filters: { label: [`${LABEL}=${id}`] } })).Volumes
          ?.length ?? 0,
        0,
      );
      assert.equal(
        (await foreign.docker.getNetwork(collision).inspect()).Labels![LABEL],
        foreign.id,
      );
    } finally {
      await infra.cleanup();
      await foreign.cleanup();
    }
  },
});

Deno.test({
  name: "Panda resources are named and labeled consistently; cleanup preserves another owner",
  ignore: Deno.env.get("PANDA_DOCKER_TEST") !== "1",
  fn: async () => {
    const infra = new Infrastructure(`names-${crypto.randomUUID().slice(0, 8)}`);
    const other = new Infrastructure(`${infra.id}-other`);
    try {
      const otherVolume = await other.volume("data");
      const network = await infra.network();
      const volume = await infra.volume("data");
      await infra.image("alpine:3.21.3");
      const container = await infra.container("probe", {
        Image: "alpine:3.21.3",
        Cmd: ["true"],
        HostConfig: { NetworkMode: network, Binds: [`${volume}:/data`] },
      });
      const info = await container.inspect();
      assert.equal(info.Name, `/panda-${infra.id}-probe`);
      assert.equal(info.Config.Labels?.["io.panda.id"], infra.id);
      assert.equal(info.Config.Labels?.["io.panda.role"], "probe");
      assert.equal((await infra.docker.getNetwork(network).inspect()).Name, `panda-${infra.id}`);
      assert.equal(volume, `panda-${infra.id}-data`);
      await infra.cleanup();
      await infra.cleanup();
      assert.equal(
        (await other.docker.getVolume(otherVolume).inspect()).Labels["io.panda.id"],
        other.id,
      );
    } finally {
      await infra.cleanup();
      await other.cleanup();
    }
  },
});
