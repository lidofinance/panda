import { JsonRpcProvider } from "ethers";
import { atomicJson } from "../../../src/artifacts.ts";
import { delay, HttpError, json } from "../../../src/http.ts";

export interface ConsumerDatabase {
  schema: 1;
  instance: string;
  cursor: { execution: number; consensus: number };
  execution: { number: number; hash: string; transactions: string[] }[];
  consensus: { slot: number; root: string }[];
}
class Diverged extends Error {}

// A deliberately separate service with its own provider and persisted history/cursors.
// It never reads Panda's local state and never rewinds itself after a snapshot restore.
if (import.meta.main) {
  const [url, beacon, database] = Deno.args;
  if (!url || !beacon || !database) throw new Error("Usage: consumer <EL URL> <CL URL> <database>");
  const provider = new JsonRpcProvider(url, 1337, { staticNetwork: true, cacheTimeout: -1 });
  const abort = new AbortController();
  const stop = () => abort.abort();
  Deno.addSignalListener("SIGTERM", stop);
  const state: ConsumerDatabase = await Deno.readTextFile(database).then(JSON.parse).catch(
    (error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return { schema: 1, cursor: { execution: -1, consensus: -1 }, execution: [], consensus: [] };
    },
  );
  state.instance = crypto.randomUUID();
  await atomicJson(database, state);
  try {
    while (!abort.signal.aborted) {
      try {
        const latest = await provider.getBlock("latest");
        if (!latest?.hash) throw new Error("Execution head unavailable");
        const header = await json<
          {
            execution_optimistic: boolean;
            data: { root: string; header: { message: { slot: string } } };
          }
        >(
          `${beacon}/eth/v1/beacon/headers/head`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (header.execution_optimistic) throw new Error("Consensus head is optimistic");
        const slot = Number(header.data.header.message.slot);
        if (latest.number < state.cursor.execution || slot < state.cursor.consensus) {
          throw new Diverged("Consumer history is ahead of Panda; reset and replay are required");
        }
        if (
          (latest.number === state.cursor.execution &&
            latest.hash !== state.execution.at(-1)?.hash) ||
          (slot === state.cursor.consensus && header.data.root !== state.consensus.at(-1)?.root)
        ) {
          throw new Diverged("Consumer history changed; reset and replay are required");
        }
        for (let number = state.cursor.execution + 1; number <= latest.number; number++) {
          const block = await provider.getBlock(number);
          if (!block?.hash) throw new Error(`Missing execution block ${number}`);
          const previous = state.execution.at(-1);
          if (previous && block.parentHash !== previous.hash) {
            throw new Diverged("Execution parent changed");
          }
          state.execution.push({ number, hash: block.hash, transactions: [...block.transactions] });
          state.cursor.execution = number;
        }
        for (let next = state.cursor.consensus + 1; next <= slot; next++) {
          try {
            const block = await json<
              { data: { root: string; header: { message: { parent_root: string } } } }
            >(
              `${beacon}/eth/v1/beacon/headers/${next}`,
              { signal: AbortSignal.timeout(3000) },
            );
            const previous = state.consensus.at(-1);
            if (previous && block.data.header.message.parent_root !== previous.root) {
              throw new Diverged("Consensus parent changed");
            }
            state.consensus.push({ slot: next, root: block.data.root });
          } catch (error) {
            // A skipped slot has no block; it still advances this consumer's scan cursor.
            if (!(error instanceof HttpError && error.status === 404)) throw error;
          }
          state.cursor.consensus = next;
        }
        await atomicJson(database, state);
      } catch (error) {
        if (error instanceof Diverged) throw error;
        if (!abort.signal.aborted) console.error(String(error));
      }
      await delay(100, abort.signal).catch((error) => {
        if (!abort.signal.aborted) throw error;
      });
    }
  } finally {
    provider.destroy();
    Deno.removeSignalListener("SIGTERM", stop);
  }
}
