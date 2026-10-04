import { json } from "../src/http.ts";

/** Readiness never advances protocol time and does not probe clients while they are parked. */
export async function health(url = "http://127.0.0.1:8545", timeoutMs = 8000): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const control = <T>(method: string) =>
    json<{ result: T }>(`${url}/control`, {
      method: "POST",
      body: JSON.stringify({ method }),
      signal,
    });
  type Lifecycle = { ready: boolean; phase: string; sessionId: string };
  const before = (await control<Lifecycle>("lifecycle")).result;
  if (!before.ready) throw new Error(`Panda service is ${before.phase}`);
  const { result: status } = await control<{
    el?: { hash: string };
    finality?: { data: unknown };
    automineError?: string;
  }>("status");
  if (!status.el?.hash || !status.finality?.data || status.automineError) {
    throw new Error("Panda service is unhealthy");
  }
  const after = (await control<Lifecycle>("lifecycle")).result;
  if (!after.ready || after.sessionId !== before.sessionId) {
    throw new Error("Panda session changed during health check");
  }
}

if (import.meta.main) await health();
