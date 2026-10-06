import { defaultTimeoutMs, HttpError, json, waitFor } from "./http.ts";
import type { Manifest } from "./network.ts";

export function needsPtcReadiness(manifest: Manifest): boolean {
  return manifest.config.mode === "controlled" && manifest.config.profile === "gloas" &&
    manifest.bake.recipe.ptcReadiness === true;
}

/** Readiness belongs to one VC process, never to its reused validator directory. */
export class PtcReadiness {
  private state = this.fresh();
  constructor(readonly timeoutMs = defaultTimeoutMs()) {}

  private fresh() {
    return {
      stop: new AbortController(),
      manifest: undefined as Manifest | undefined,
      indicesComplete: false,
      failures: new Map<string, number>(),
      readyEpoch: undefined as number | undefined,
    };
  }

  reset(): void {
    this.close();
    this.state = this.fresh();
  }

  close(): void {
    this.state.stop.abort(new Error("Validator bootstrap replaced or closed"));
  }

  bind(manifest: Manifest): void {
    if (!manifest.vcMetrics) throw new Error("Missing validator PTC metrics endpoint");
    for (const endpoint of [manifest.vc, manifest.vcMetrics, manifest.vcClock]) {
      if (new URL(endpoint).hostname !== "127.0.0.1") {
        throw new Error("Validator readiness endpoints must be local");
      }
    }
    this.state.manifest = manifest;
  }

  /** Capture the generation before forwarding, so late old responses cannot poison its successor. */
  indexRequest(pubkey: string): (status: number) => void {
    const state = this.state;
    return (status) => {
      if (state.stop.signal.aborted) return;
      if (status === 200 || status === 404) state.failures.delete(pubkey);
      else state.failures.set(pubkey, status);
    };
  }

  async beforeDuties(signal?: AbortSignal): Promise<void> {
    const state = this.state;
    const budget = AbortSignal.any([
      state.stop.signal,
      AbortSignal.timeout(this.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    if (!state.indicesComplete) {
      await waitFor("complete validator index discovery", async () => {
        if (budget.aborted) return true;
        const m = state.manifest;
        if (!m) return;
        const clock = await json<{ nowMs: number; marks: Record<string, number> }>(m.vcClock, {
          signal: budget,
        });
        const slot = Math.floor((clock.nowMs / 1000 - m.config.genesisTime) / 12);
        return clock.marks.ready === 0 && clock.marks.indices === slot ? true : undefined;
      }, this.timeoutMs);
      budget.throwIfAborted();
      if (state.failures.size) {
        throw new Error(`Validator index discovery failed: ${JSON.stringify([...state.failures])}`);
      }
      state.indicesComplete = true;
    }
    budget.throwIfAborted();
    if (state.failures.size) throw new Error("Validator index lookup failed");
  }

  /** Query native duties for every enabled owned key, then check the VC's actual cached row counts. */
  async beforePtcDeadline(slot: number): Promise<void> {
    const state = this.state;
    await this.beforeDuties();
    state.stop.signal.throwIfAborted();
    const epoch = Math.floor(slot / 32);
    if (state.readyEpoch === epoch) return;
    const m = state.manifest!;
    const budget = AbortSignal.any([state.stop.signal, AbortSignal.timeout(this.timeoutMs)]);
    const token = (await Deno.readTextFile(
      `${m.directory}/validator-keys/keys/api-token.txt`,
    )).trim();
    const keys = await json<{ data: { validating_pubkey: string }[] }>(`${m.vc}/eth/v1/keystores`, {
      headers: { authorization: `Bearer ${token}` },
      signal: budget,
    });
    const indices: string[] = [];
    for (const key of keys.data) {
      if (!/^0x[0-9a-f]{96}$/i.test(key.validating_pubkey)) {
        throw new Error("Invalid validator keymanager public key");
      }
      try {
        const validator = await json<{ data: { index: string } }>(
          `${m.beacon}/eth/v1/beacon/states/head/validators/${key.validating_pubkey}`,
          { signal: budget },
        );
        if (!/^\d+$/.test(validator.data.index)) throw new Error("Invalid validator index");
        indices.push(validator.data.index);
      } catch (error) {
        // Imported keys may not yet be registered on chain. Every other lookup failure is fatal.
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
    const counts: number[] = [];
    for (const target of [epoch, epoch + 1]) {
      const duties = await json<{ data: unknown[] }>(
        `${m.beacon}/eth/v1/validator/duties/ptc/${target}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(indices),
          signal: budget,
        },
      );
      if (!Array.isArray(duties.data)) throw new Error("Invalid native PTC duties");
      counts.push(duties.data.length);
    }
    await waitFor(`validator PTC cache rows ${counts.join("/")} at epoch ${epoch}`, async () => {
      if (budget.aborted) return true;
      const response = await fetch(`${m.vcMetrics}/metrics`, { signal: budget });
      if (!response.ok) throw new Error(`Validator metrics returned ${response.status}`);
      const metrics = await response.text();
      return ["current_epoch", "next_epoch"].every((task, index) => {
          const value = metrics.match(
            new RegExp(`^vc_beacon_ptc_count\\{task="${task}"\\} ([0-9]+)$`, "m"),
          );
          return value !== null && Number(value[1]) === counts[index];
        })
        ? true
        : undefined;
    }, this.timeoutMs);
    budget.throwIfAborted();
    state.readyEpoch = epoch;
  }
}
