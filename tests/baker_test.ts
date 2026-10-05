import assert from "node:assert/strict";
import { bake } from "../src/baker.ts";
import { configuration } from "../src/config.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { pinImage, requireImage } from "../src/baker.ts";
import { bakePath, readBake } from "../src/profiles.ts";
Deno.test({
  name:
    "baker pins imports, reuses artifacts across tags and preserves a tag on failed replacement",
  ignore: Deno.env.get("PANDA_DOCKER_TEST") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const config = configuration();
    const selected = await readBake(config.profile, config.bake);
    const first = `test-${crypto.randomUUID().slice(0, 8)}`;
    const second = `${first}-alias`;
    try {
      const one = await bake(config.profile, {
        tag: first,
        importCl: selected.images.cl.id,
        elImage: selected.images.el.id,
      });
      assert.equal(one.images.cl.id, selected.images.cl.id);
      assert.equal(one.source.importedCl, selected.images.cl.id);
      const reused = await bake(config.profile, { tag: first });
      assert.deepEqual(reused, one);
      const alias = await bake(config.profile, {
        tag: second,
        importCl: selected.images.cl.id,
        elImage: selected.images.el.id,
      });
      assert.equal(alias.key, one.key);
      assert.deepEqual(alias.images, one.images);
      const before = await Deno.readTextFile(bakePath(config.profile, first));
      await assert.rejects(
        () => bake(config.profile, { tag: first, importCl: selected.images.cl.id }),
        /already exists/,
      );
      await assert.rejects(
        () =>
          bake(config.profile, {
            tag: first,
            replace: true,
            patch: `.cache/absent-${first}.patch`,
          }),
        /No such file|not found/i,
      );
      assert.equal(await Deno.readTextFile(bakePath(config.profile, first)), before);
    } finally {
      for (const tag of [first, second]) {
        await Deno.remove(bakePath(config.profile, tag)).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      }
    }
  },
});

Deno.test({
  name: "local bake archive restores the identical image after removal from Docker",
  ignore: Deno.env.get("PANDA_DOCKER_TEST") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const infra = new Infrastructure(`archive-${crypto.randomUUID().slice(0, 8)}`);
    const directory = await Deno.makeTempDir();
    let id: string | undefined;
    const removeOwnedImage = async () => {
      if (!id) return;
      const image = infra.docker.getImage(id);
      let info;
      try {
        info = await image.inspect();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return;
        throw error;
      }
      assert.equal(info.Config.Labels?.[LABEL], infra.id);
      await image.remove();
    };
    try {
      await Deno.writeTextFile(`${directory}/Dockerfile`, "FROM scratch\nCOPY stamp /stamp\n");
      await Deno.writeTextFile(`${directory}/stamp`, crypto.randomUUID());
      const tag = `panda-archive-test:${infra.id}`;
      const stream = await infra.docker.buildImage({
        context: directory,
        src: ["Dockerfile", "stamp"],
      }, {
        t: tag,
        labels: infra.labels,
      });
      await new Promise<void>((resolve, reject) => {
        infra.docker.modem.followProgress(
          stream,
          (error: Error | null) => error ? reject(error) : resolve(),
        );
      });
      const baked = await pinImage(infra, tag);
      id = baked.id;
      await removeOwnedImage();
      assert.equal(await requireImage(infra, baked), id);
      assert.equal((await infra.docker.getImage(id).inspect()).Id, id);
      await removeOwnedImage();
      assert.equal((await pinImage(infra, id)).id, id);
    } finally {
      await removeOwnedImage();
      if (id) await Deno.remove(`.cache/baker/images/${id.slice(7)}.tar.gz`);
      await Deno.remove(directory, { recursive: true });
    }
  },
});
