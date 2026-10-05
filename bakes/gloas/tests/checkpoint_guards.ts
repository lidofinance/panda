import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { Controller } from "../../../src/controller.ts";
import { GENERATION, LABEL } from "../../../src/docker.ts";
import { deadline, json } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { fileInventory } from "../../../src/storage.ts";
import { exportSigningHistory } from "../../shared/tests/signing_history.ts";

/** Real-client boundary checks complement the independent continuation comparison. */
export async function checkpointGuards() {
  const c = await Controller.start({ id: `checkpoint-${crypto.randomUUID().slice(0, 8)}` });
  const api = new Devnet(c.serve(0));
  try {
    const initial = await api.status();
    const events = await fetch(`${api.beaconUrl}/eth/v1/events?topics=head`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(events.status, 200);
    assert.equal(c.lifecycle().streams, 1);
    const reader = events.body!.getReader();
    const disconnected = (async () => {
      try {
        while (!(await reader.read()).done) { /* Consume until maintenance cancels SSE. */ }
      } catch {
        /* Closing a session may terminate an HTTP stream with EOF or reset. */
      } finally {
        reader.releaseLock();
      }
    })();
    const genesis = await api.stop();
    await deadline(disconnected, 5000, "managed Beacon SSE cancellation");
    assert.equal(c.lifecycle().streams, 0);
    assert.equal(genesis.headSlot, 0, "saving the fresh network must not produce a block");
    await api.resume();
    assert.equal((await api.status()).now, initial.now);
    assert.equal((await api.status()).el.hash, initial.el.hash);
    await api.advanceSlots(3);
    const m = c.manifest;
    const head = await api.beacon("/eth/v1/beacon/headers/head");
    const history = await exportSigningHistory(m);
    // Exact pinned Geth rejects this encoding before admission; it must not poison saves.
    await assert.rejects(
      api.rpc("eth_sendRawTransaction", ["0x02"]),
      /typed transaction too short/,
    );
    for (const clock of [m.vcClock, m.bnClock]) {
      const parked = await json<{ parked: boolean; activeWork: number }>(`${clock}/park`, {
        method: "POST",
      });
      assert.equal(parked.parked, true);
      assert.equal(parked.activeWork, 0);
    }
    const clocks = await Promise.all([m.bnClock, m.vcClock].map((url) => json(url)));
    const blocked = await fetch(`${m.beacon}/eth/v1/validator/prepare_beacon_proposer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
      signal: AbortSignal.timeout(10_000),
    });
    const denied = await blocked.text();
    assert.equal(blocked.status, 400, denied);
    assert.match(denied, /native writes are parked/);
    const hidden = await fetch(`${api.beaconUrl}/lighthouse/panda/checkpoint`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(hidden.status, 403);
    await hidden.arrayBuffer();
    const receipt = await json(`${m.beacon}/lighthouse/panda/checkpoint`, { method: "POST" });
    for (let read = 0; read < 2; read++) {
      assert.deepEqual(await json(`${m.beacon}/lighthouse/panda/checkpoint`), receipt);
      assert.deepEqual(await api.beacon("/eth/v1/beacon/headers/head"), head);
    }
    assert.deepEqual(
      await exportSigningHistory(m),
      history,
      "parked reads changed signing history",
    );
    assert.deepEqual(
      await Promise.all([m.bnClock, m.vcClock].map((url) => json(url))),
      clocks,
      "checkpoint/readback advanced time or fabricated completion marks",
    );
    for (const clock of [m.bnClock, m.vcClock]) await json(`${clock}/resume`, { method: "POST" });
    await api.stop();
    const generation = c.network.generation!;
    const before = await fileInventory(c.network.store.generationPath(generation.generation));
    const copy = await c.network.store.allocate(generation.config, generation.bakeKey);
    try {
      await c.network.infra.copyGeneration(c.network.store, generation, copy);
      const after = await fileInventory(c.network.store.generationPath(copy.generation));
      delete before["owner.json"];
      delete after["owner.json"];
      assert.deepEqual(after, before, "real stopped EL/BN/VC generation copy changed data");
      assert.equal((await c.network.store.active())?.generation, generation.generation);
    } finally {
      await Deno.remove(await c.network.store.validate(copy), { recursive: true });
    }
    // Fault injection into actual stopped databases. Restore the exact bytes/metadata in the
    // fixture only after proving that no client was started; this is not a recovery API.
    const root = c.network.store.generationPath(generation.generation);
    const tables = generation.checkpoint!.databaseFiles as Record<
      "el" | "bn",
      Record<string, { size: number }>
    >;
    const smallFile = (role: "el" | "bn") => {
      const entry = Object.entries(tables[role]).filter(([, item]) => item.size > 0)
        .sort((a, b) => a[1].size - b[1].size)[0];
      assert(entry, `no actual ${role} database file`);
      return `${root}/${role}/${entry[0]}`;
    };
    const corruptions = [
      { path: smallFile("el"), remove: false, error: /database files changed/ },
      { path: smallFile("bn"), remove: true, error: /database files changed/ },
      {
        path: `${m.directory}/validator-keys/keys/slashing_protection.sqlite`,
        remove: true,
        error: /keys or slashing protection data changed/,
      },
    ];
    for (const [index, corruption] of corruptions.entries()) {
      const backup = `${c.network.store.root}/guard-backup-${index}`;
      await Deno.rename(corruption.path, backup);
      try {
        if (!corruption.remove) await Deno.writeTextFile(corruption.path, "corrupt database");
        await assert.rejects(new Network(m.config).start("resume"), corruption.error);
        assert.equal((await c.network.store.active())?.phase, "faulted");
        assert.equal(
          (await c.network.infra.docker.listContainers({
            all: true,
            filters: {
              label: [`${LABEL}=${m.config.id}`, `${GENERATION}=${generation.generation}`],
            },
          })).length,
          0,
          "invalid checkpoint started a client",
        );
      } finally {
        if (!corruption.remove) await Deno.remove(corruption.path);
        await Deno.rename(backup, corruption.path);
        await c.network.store.write(generation);
      }
    }
    await api.resume();
    assert.deepEqual(await api.beacon("/eth/v1/beacon/headers/head"), head);
    await api.stepSlot();
    assert.equal((await api.status()).slot, 4);
    return { passed: true, bakeKey: m.bake.key, checkpoint: receipt };
  } finally {
    await api.close();
    await c.close();
  }
}
