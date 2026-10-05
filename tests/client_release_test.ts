import assert from "node:assert/strict";
import { join } from "node:path";
import {
  clientLockPath,
  pinPublishedClients,
  type PublishedClients,
  readPublishedClients,
  restorePublishedClients,
  validatePublishedClients,
} from "../src/client_release.ts";
import { Infrastructure, LABEL } from "../src/docker.ts";
import { type BakedImage, bakePath, profiles, readBake } from "../src/profiles.ts";
import { lighthouseBuild, lighthouseTag } from "../src/lighthouse_build.ts";
import { lighthouseImage, releaseImage, releaseMetadata } from "../src/release.ts";

// Unit fixtures model published amd64 artifacts; they are not client build evidence.
async function fixture(): Promise<PublishedClients> {
  const bake = await readBake("gloas", "panda");
  bake.tag = "unit-client-set";
  bake.recipe.clVersion = profiles.gloas.clVersion;
  bake.recipe.bakerVersion = profiles.gloas.bakerVersion;
  bake.lighthouse = await lighthouseBuild(profiles.gloas, "linux/amd64");
  for (const [role, image] of Object.entries(bake.images)) {
    image.platform = "linux/amd64";
    image.digest = `example.test/${role}@sha256:${"a".repeat(64)}`;
  }
  return {
    schema: 1,
    bake,
    lighthouse: {
      image: lighthouseImage("eddort", "gloas", lighthouseTag(bake.lighthouse)),
      digest: `ghcr.io/eddort/panda-lighthouse-gloas@sha256:${"b".repeat(64)}`,
      sourceCommit: "c".repeat(40),
      build: bake.lighthouse,
    },
  };
}

Deno.test("two Panda Git releases reuse the same published Lighthouse and original bake", async () => {
  const release = await fixture();
  const root = await Deno.makeTempDir();
  try {
    const original = structuredClone(release.bake);
    assert.equal(await pinPublishedClients(release, root), join(root, clientLockPath("gloas")));
    const selected = await readPublishedClients("gloas", root);
    const pulls: BakedImage[] = [];
    await restorePublishedClients(selected, (image) => {
      pulls.push(image);
      return Promise.resolve();
    }, root);
    assert.equal(pulls.length, 4);
    assert.equal(
      pulls.find((image) => image.id === release.bake.images.cl.id)?.digest,
      release.lighthouse.digest,
    );
    assert.ok(pulls.every((image) => image.digest?.includes("@sha256:")));
    const restored = JSON.parse(
      await Deno.readTextFile(join(root, bakePath("gloas", "unit-client-set"))),
    );
    assert.deepEqual(restored, original);
    const first = releaseMetadata(
      restored,
      releaseImage("eddort", "gloas", "v1.0.0"),
      "d".repeat(40),
      selected.lighthouse,
    );
    const next = releaseMetadata(
      restored,
      releaseImage("eddort", "gloas", "v1.0.1"),
      "e".repeat(40),
      selected.lighthouse,
    );
    assert.equal(first.bake, "unit-client-set");
    assert.equal(next.bakeKey, first.bakeKey);
    assert.deepEqual(first.clients, next.clients);
    assert.equal(next.clients.cl.digest, release.lighthouse.digest);
    assert.deepEqual(release.bake, original);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("published locks reject mutable clients, wrong forks, architecture and imported provenance", async () => {
  const release = await fixture();
  const invalid = [
    (value: PublishedClients) => {
      value.bake.images.el.digest = "ethereum/client-go:latest";
    },
    (value: PublishedClients) => {
      value.bake.images.genesis.digest = undefined;
    },
    (value: PublishedClients) => {
      value.bake.images.cl.platform = "linux/arm64";
    },
    (value: PublishedClients) => {
      value.lighthouse.digest = `ghcr.io/eddort/panda-lighthouse-pectra@sha256:${"b".repeat(64)}`;
    },
    (value: PublishedClients) => {
      value.lighthouse.build = {
        ...value.lighthouse.build,
        baker: {
          ...value.lighthouse.build.baker,
          version: value.lighthouse.build.baker.version + 1,
        },
      };
    },
    (value: PublishedClients) => {
      value.bake.source.importedCl = value.bake.images.cl.id;
    },
    (value: PublishedClients) => {
      value.lighthouse.sourceCommit = "main";
    },
  ];
  for (const mutate of invalid) {
    const value = structuredClone(release);
    mutate(value);
    assert.throws(() => validatePublishedClients(value, "gloas"));
  }
  assert.throws(() => validatePublishedClients(release, "pectra"));
});

Deno.test("missing clients never compile, failed pulls never install a bake, conflicting tags survive", async () => {
  const release = await fixture();
  const root = await Deno.makeTempDir();
  try {
    await assert.rejects(
      () => readPublishedClients("gloas", root),
      /Missing published clients.*never compiles clients/,
    );
    await assert.rejects(
      () => restorePublishedClients(release, () => Promise.reject(new Error("pull failed")), root),
      /pull failed/,
    );
    await assert.rejects(
      () => Deno.stat(join(root, bakePath("gloas", "unit-client-set"))),
      Deno.errors.NotFound,
    );
    const path = join(root, bakePath("gloas", "unit-client-set"));
    await Deno.mkdir(join(root, "bakes/gloas/tags"), { recursive: true });
    const previous = JSON.stringify({ ...release.bake, key: "f".repeat(64) });
    await Deno.writeTextFile(path, previous);
    let pulls = 0;
    await assert.rejects(() =>
      restorePublishedClients(release, () => {
        pulls++;
        return Promise.resolve();
      }, root), /Conflicting immutable bake/);
    assert.equal(pulls, 0);
    assert.equal(await Deno.readTextFile(path), previous);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("registry restoration checks actual image identity and architecture using an in-memory Docker transport", async () => {
  const release = await fixture();
  const image = { ...release.bake.images.cl, digest: release.lighthouse.digest };
  for (
    const [id, architecture, valid] of [
      [image.id, "amd64", true],
      ["sha256:" + "f".repeat(64), "amd64", false],
      [image.id, "arm64", false],
    ] as const
  ) {
    const refs: string[] = [];
    const fake = {
      getImage(ref: string) {
        refs.push(ref);
        return {
          inspect: () => Promise.resolve({ Id: id, Os: "linux", Architecture: architecture }),
        };
      },
    };
    const infra = new Infrastructure("release-unit", fake as unknown as Infrastructure["docker"]);
    if (valid) await infra.registryImage(image);
    else await assert.rejects(() => infra.registryImage(image), /identity\/platform mismatch/);
    assert.ok(refs.every((ref) => ref === image.digest));
  }
});

Deno.test("client publishing refuses a foreign image before tagging or pushing (in-memory transport)", async () => {
  let mutations = 0;
  const fake = {
    getImage() {
      return {
        inspect: () => Promise.resolve({ Config: { Labels: { [LABEL]: "another-owner" } } }),
        tag: () => {
          mutations++;
          return Promise.resolve();
        },
        push: () => {
          mutations++;
          return Promise.resolve();
        },
      };
    },
  };
  const infra = new Infrastructure("release-unit", fake as unknown as Infrastructure["docker"]);
  await assert.rejects(
    () => infra.publishImage("sha256:" + "a".repeat(64), "example.test/test:r1", {}),
    /not owned/,
  );
  assert.equal(mutations, 0);
});
