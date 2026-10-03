/** Run a new regression against archived native inputs without changing an immutable bake. */
import { resolve } from "node:path";
import { BuildLock, requireImage } from "../../../src/artifacts.ts";
import { git, snapshotSources } from "../../../src/baker.ts";
import { Infrastructure } from "../../../src/docker.ts";
import { readBake, sha256 } from "../../../src/profiles.ts";

const bake = await readBake("gloas", Deno.env.get("PANDA_BAKE") ?? "default");
const test = await Deno.readTextFile("bakes/gloas/native/restart_test.rs");
const testHash = await sha256(test);
const key = await sha256(`${bake.key}:${testHash}`);
const evidenceRoot = resolve(`.cache/p0-p1/native/${key}`);
const root = `${evidenceRoot}/source`;
await using _lock = await BuildLock.acquire(`.cache/baker/locks/restart-${key}.lock`);
const inputs = await snapshotSources(bake.hashes, `.cache/baker/inputs/${bake.key}`);
await Deno.mkdir(root, { recursive: true });
await git(["init"], root);
await git(["fetch", "--depth=1", bake.recipe.clRepository, bake.source.cl], root);
if (await git(["rev-parse", "FETCH_HEAD"], root) !== bake.source.cl) {
  throw new Error("Native regression source revision mismatch");
}
// This directory belongs only to this experiment; the baker's immutable source cache is untouched.
await git(["checkout", "--force", "--detach", bake.source.cl], root);
// Remove only generated overlay files in this disposable checkout. Evidence lives outside it.
await git(["clean", "-fd"], root);
const patch = `${root}/regression-base.patch`;
await Deno.writeTextFile(patch, inputs[bake.recipe.patch]);
await git(["apply", "--check", patch], root);
await git(["apply", patch], root);
await Deno.writeTextFile(
  `${root}/common/slot_clock/src/controlled.rs`,
  inputs[bake.recipe.clockSource],
);
await Deno.writeTextFile(`${root}/beacon_node/beacon_chain/tests/panda_restart.rs`, test);
// New bakes already register this target in their archived patch. Historical
// bakes need the declaration as part of this regression-only overlay.
if (
  !bake.recipe.nativeTests?.some((entry) =>
    entry.package === "beacon_chain" && entry.target === "panda_restart"
  )
) {
  await Deno.writeTextFile(
    `${root}/beacon_node/beacon_chain/Cargo.toml`,
    '\n[[test]]\nname = "panda_restart"\npath = "tests/panda_restart.rs"\n',
    { append: true },
  );
}
const evidence = {
  bakeKey: bake.key,
  upstream: bake.source.cl,
  nativeTestHash: testHash,
  builder: bake.builders.rust,
};
await Deno.writeTextFile(`${evidenceRoot}/inputs.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
const infra = new Infrastructure(`restart-native-${key.slice(0, 16)}`);
await requireImage(infra, bake.builders.rust);
const cacheId = `bake-cache-${bake.builders.rust.id.slice(7, 23)}`;
await using _cacheLock = await BuildLock.acquire(`.cache/baker/locks/${cacheId}-cl.lock`);
const cacheInfra = new Infrastructure(cacheId);
const cache = await cacheInfra.volume("cl-cache");
const target = await cacheInfra.volume("cl-target");
// A test executable only: no client image build, publication or tag changes.
const container = await infra.compilerContainer("cl", {
  Image: bake.builders.rust.id,
  WorkingDir: "/source",
  Env: ["CARGO_TARGET_DIR=/target", "CARGO_BUILD_JOBS=2", "CARGO_NET_GIT_FETCH_WITH_CLI=true"],
  Cmd: [
    "sh",
    "-ec",
    "apt-get update && apt-get install -y --no-install-recommends cmake libclang-dev protobuf-compiler && cargo test --release --locked -p beacon_chain --test panda_restart -- --nocapture",
  ],
  HostConfig: { Binds: [`${root}:/source`, `${cache}:/usr/local/cargo`, `${target}:/target`] },
});
try {
  await container.start();
  const stream = await container.logs({ follow: true, stdout: true, stderr: true });
  const process = await import("node:process");
  infra.docker.modem.demuxStream(stream, process.stdout, process.stderr);
  const status = await container.wait();
  await Deno.writeTextFile(
    `${evidenceRoot}/result.json`,
    JSON.stringify({ ...evidence, exitCode: status.StatusCode }, null, 2),
  );
  if (status.StatusCode) {
    throw new Error(
      `Native restart regression exited ${status.StatusCode}; inspect the test output`,
    );
  }
} finally {
  await container.remove({ force: true });
}
