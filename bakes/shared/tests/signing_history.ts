import assert from "node:assert/strict";
import { GENERATION, Infrastructure, LABEL, ROLE } from "../../../src/docker.ts";
import type { Manifest } from "../../../src/network.ts";
import { clockEnvironment } from "../../../src/profiles.ts";
import type { SigningHistory } from "./warp_assertions.ts";

/** The pinned Lighthouse startup prunes history older than one epoch, but keeps each
 * validator's maximum proposal/target even when older. Compare this retained history,
 * not the timing of its asynchronous background pruning.
 * See lighthouse_validator_store::prune_slashing_protection_db and
 * slashing_database::{prune_signed_blocks, prune_signed_attestations}. */
export function retainedSigningHistory(history: SigningHistory, slot: number): SigningHistory {
  assert(Number.isSafeInteger(slot) && slot >= 0);
  const minimumEpoch = BigInt(Math.max(0, Math.floor(slot / 32) - 1));
  const result = structuredClone(history);
  const max = (values: string[]) => values.reduce((n, v) => BigInt(v) > n ? BigInt(v) : n, -1n);
  for (const record of result.data) {
    const lastProposal = max(record.signed_blocks.map((v) => v.slot));
    const lastTarget = max(record.signed_attestations.map((v) => v.target_epoch));
    record.signed_blocks = record.signed_blocks.filter((v) =>
      BigInt(v.slot) >= minimumEpoch * 32n || BigInt(v.slot) === lastProposal
    );
    record.signed_attestations = record.signed_attestations.filter((v) =>
      BigInt(v.target_epoch) >= minimumEpoch || BigInt(v.target_epoch) === lastTarget
    );
  }
  return result;
}

/** Export a consistent copy without resetting or unlocking the live signing database. */
export async function exportSigningHistory(manifest: Manifest): Promise<SigningHistory> {
  const infra = new Infrastructure(manifest.config.id);
  const containers = await infra.docker.listContainers({
    filters: {
      label: [
        `${LABEL}=${manifest.config.id}`,
        `${ROLE}=vc`,
        ...(manifest.generation ? [`${GENERATION}=${manifest.generation}`] : []),
      ],
    },
  });
  assert.equal(containers.length, 1);
  const vc = infra.docker.getContainer(containers[0].Id);
  assert.equal((await vc.inspect()).Config.Labels?.[LABEL], manifest.config.id);
  // Lighthouse holds an exclusive SQLite lock. Copy the database and journals while frozen.
  const snapshot = `${manifest.directory}/signing-history-copy`;
  await Deno.mkdir(snapshot, { recursive: true });
  await vc.pause();
  try {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const name = `slashing_protection.sqlite${suffix}`;
      await Deno.remove(`${snapshot}/${name}`).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      await Deno.copyFile(
        `${manifest.directory}/validator-keys/keys/${name}`,
        `${snapshot}/${name}`,
      )
        .catch((error) => {
          if (suffix === "" || !(error instanceof Deno.errors.NotFound)) throw error;
        });
    }
  } finally {
    await vc.unpause();
  }
  await infra.exec(vc, [
    "env",
    "-u",
    clockEnvironment(manifest.bake.recipe).startMs,
    "-u",
    clockEnvironment(manifest.bake.recipe).port,
    "lighthouse",
    "--testnet-dir=/shared/metadata",
    "account",
    "validator",
    "--validators-dir=/shared/signing-history-copy",
    "slashing-protection",
    "export",
    "/shared/signing-history.json",
  ]);
  const history: SigningHistory = JSON.parse(
    await Deno.readTextFile(`${manifest.directory}/signing-history.json`),
  );
  await Deno.remove(snapshot, { recursive: true });
  await Deno.remove(`${manifest.directory}/signing-history.json`);
  // Export order is not part of the slashing-protection interchange format.
  history.data.sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  for (const record of history.data) {
    record.signed_blocks.sort((a, b) => Number(BigInt(a.slot) - BigInt(b.slot)));
    record.signed_attestations.sort((a, b) =>
      Number(BigInt(a.target_epoch) - BigInt(b.target_epoch))
    );
  }
  return history;
}
