/** A runtime watchdog, not a performance target. Tests may supply a stricter budget. */
export function defaultTimeoutMs(): number {
  const value = Number(Deno.env.get("PANDA_TIMEOUT_MS") ?? 3_600_000);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("PANDA_TIMEOUT_MS must be an integer from 1 to 2147483647");
  }
  return value;
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function deadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = defaultTimeoutMs(),
): Promise<T> {
  const end = performance.now() + timeoutMs;
  let last: unknown;
  let pause = 10;
  while (performance.now() < end) {
    try {
      const value = await deadline(probe(), Math.max(1, end - performance.now()), description);
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await delay(Math.min(pause, Math.max(0, end - performance.now())));
    pause = Math.min(250, pause * 1.5);
  }
  throw new Error(`Timed out: ${description} (${timeoutMs} ms)${last ? ` (${last})` : ""}`);
}
export class HttpError extends Error {
  constructor(readonly status: number, url: string, body: string) {
    super(`${status} ${url}: ${body}`);
  }
}
export async function json<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(defaultTimeoutMs()),
  });
  if (!response.ok) throw new HttpError(response.status, url, await response.text());
  return await response.json();
}
export async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await json<{ result: T; error?: { code: number; message: string } }>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (response.error) {
    throw new Error(`${method}: ${response.error.message} (${response.error.code})`);
  }
  return response.result;
}

/** Preserve decoded fetch bodies without advertising their former compressed size. */
export function forwardedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  if (response.url && /^(gzip|deflate|br)$/i.test(headers.get("content-encoding") ?? "")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  return headers;
}
