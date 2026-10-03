/** Test the actual pinned generator with a future schedule; this does not claim fork crossing. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { requireImage } from "../../../src/artifacts.ts";
import { account, mnemonic } from "../../../src/config.ts";
import { Infrastructure } from "../../../src/docker.ts";
import { deadline } from "../../../src/http.ts";
import { readBake, sha256 } from "../../../src/profiles.ts";

const bake = await readBake("gloas", Deno.env.get("PANDA_BAKE") ?? "default");
const id = `fork-genesis-${crypto.randomUUID().slice(0, 8)}`;
const infra = new Infrastructure(id);
const directory = resolve(`.cache/p0-p1/${id}`);
await Deno.mkdir(directory, { recursive: true });
const genesisTime = 2_000_000_000;
const alignedBpo = Deno.args[0] === "--aligned-bpo";
if (Deno.args.length && !alignedBpo) throw new Error("Usage: fork_genesis.ts [--aligned-bpo]");
const schedule = {
  ELECTRA_FORK_EPOCH: "0",
  FULU_FORK_EPOCH: "2",
  GLOAS_FORK_EPOCH: "4",
  HEZE_FORK_EPOCH: "18446744073709551615",
};
try {
  const generator = await infra.container("genesis", {
    Image: await requireImage(infra, bake.images.genesis),
    User: `${Deno.uid()}:${Deno.gid()}`,
    Env: [
      "CHAIN_ID=1337",
      "NUMBER_OF_VALIDATORS=64",
      `EL_AND_CL_MNEMONIC=${mnemonic}`,
      `GENESIS_TIMESTAMP=${genesisTime}`,
      "GENESIS_DELAY=0",
      "SLOT_DURATION_IN_SECONDS=12",
      "SLOT_DURATION_MS=12000",
      "DEPOSIT_CONTRACT_ADDRESS=0x4242424242424242424242424242424242424242",
      "WITHDRAWAL_TYPE=0x01",
      `WITHDRAWAL_ADDRESS=${account}`,
      `EL_PREMINE_ADDRS={"${account}":{"balance":"1000000ETH"}}`,
      ...Object.entries(schedule).map(([name, value]) => `${name}=${value}`),
      ...(alignedBpo ? ["BPO_1_EPOCH=2", "BPO_2_EPOCH=3"] : []),
    ],
    Cmd: ["all"],
    HostConfig: { Binds: [`${directory}:/data`], NetworkMode: "none" },
  });
  await generator.start();
  const status = await deadline(generator.wait(), 120_000, "scheduled genesis generation");
  await Deno.writeTextFile(`${directory}/generator.log`, await infra.logs(generator));
  assert.equal(status.StatusCode, 0, "generator failed; inspect generator.log");
  const el = JSON.parse(await Deno.readTextFile(`${directory}/metadata/genesis.json`));
  const yaml = await Deno.readTextFile(`${directory}/metadata/config.yaml`);
  const field = (name: string) => {
    const match = yaml.match(new RegExp(`^${name}:\\s*["']?([^\\s"'#]+)`, "m"));
    assert(match, `missing ${name}`);
    return match[1];
  };
  for (const [name, epoch] of Object.entries(schedule)) assert.equal(field(name), epoch);
  assert.equal(el.config.pragueTime, 0);
  assert.equal(el.config.osakaTime, genesisTime + 2 * 32 * 12);
  assert.equal(el.config.amsterdamTime, genesisTime + 4 * 32 * 12);
  if (alignedBpo) {
    assert.equal(el.config.bpo1Time, el.config.osakaTime);
    assert.equal(el.config.bpo2Time, genesisTime + 3 * 32 * 12);
    const blobSchedule = yaml.split(/^BLOB_SCHEDULE:/m)[1]?.split(/^[A-Z_]+:/m)[0];
    assert(blobSchedule, "missing CL blob schedule");
    assert.deepEqual(
      Array.from(
        blobSchedule.matchAll(/- EPOCH:\s*(\d+)\s*\n\s+MAX_BLOBS_PER_BLOCK:\s*(\d+)/g),
        (entry) => [Number(entry[1]), Number(entry[2])],
      ),
      [[2, 15], [3, 21]],
    );
  }
  const state = await Deno.readFile(`${directory}/metadata/genesis.ssz`);
  // BeaconState's common fixed prefix: time, validators root, slot, Fork. No fork-specific offsets.
  const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
  assert.equal(view.getBigUint64(0, true), BigInt(genesisTime));
  assert.equal(view.getBigUint64(40, true), 0n);
  assert.equal(
    `0x${Array.from(state.slice(52, 56), (v) => v.toString(16).padStart(2, "0")).join("")}`,
    field("ELECTRA_FORK_VERSION"),
    "CL genesis must start in Electra, not Gloas",
  );
  assert.equal(view.getBigUint64(56, true), 0n);
  const init = await infra.container("init", {
    Image: await requireImage(infra, bake.images.el),
    Cmd: ["--datadir=/el", "init", "/shared/metadata/genesis.json"],
    HostConfig: {
      Binds: [`${directory}:/shared:ro`, `${await infra.volume("el")}:/el`],
      NetworkMode: "none",
    },
  });
  await init.start();
  const initialized = await deadline(init.wait(), 60_000, "Geth scheduled genesis init");
  await Deno.writeTextFile(`${directory}/geth-init.log`, await infra.logs(init));
  assert.equal(initialized.StatusCode, 0, "pinned Geth rejected the generated schedule");
  const evidence = {
    event: "fork-genesis-passed",
    bakeKey: bake.key,
    images: { genesis: bake.images.genesis, el: bake.images.el },
    schedule,
    alignedBpo,
    elConfig: el.config,
    genesisStateHash: await sha256(state),
  };
  await Deno.writeTextFile(".cache/p0-p1/fork-genesis.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await infra.cleanup();
}
