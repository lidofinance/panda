import type { ConsensusMessages } from "./consensus_messages.ts";
import type { PtcReadiness } from "./ptc_readiness.ts";

/** Match the pinned ValidatorData fields that the VC must deserialize before learning an index. */
function validIndex(body: unknown, pubkey: string): boolean {
  if (!body || typeof body !== "object") return false;
  const data = (body as { data?: Record<string, unknown> }).data;
  if (!data || typeof data !== "object") return false;
  const validator = data.validator as Record<string, unknown> | undefined;
  const uint64 = (value: unknown) =>
    typeof value === "string" && /^\d+$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn;
  return uint64(data.index) && uint64(data.balance) && typeof data.status === "string" &&
    /^(pending(_initialized|_queued)?|active(_ongoing|_exiting|_slashed)?|exited(_unslashed|_slashed)?|withdrawal(_possible|_done)?)$/
      .test(data.status) &&
    !!validator &&
    typeof validator.pubkey === "string" &&
    validator.pubkey.toLowerCase() === pubkey.toLowerCase() &&
    typeof validator.withdrawal_credentials === "string" &&
    /^0x[0-9a-f]{64}$/i.test(validator.withdrawal_credentials) &&
    typeof validator.slashed === "boolean" && [
    "effective_balance",
    "activation_eligibility_epoch",
    "activation_epoch",
    "exit_epoch",
    "withdrawable_epoch",
  ].every((field) => uint64(validator[field]));
}

/** Private VC ingress; public Beacon requests use the same capture buffer in Controller. */
export class BeaconRelay {
  readonly server: Deno.HttpServer<Deno.NetAddr>;
  readonly url: string;
  private readonly stop = new AbortController();

  constructor(
    public upstream: string,
    readonly messages: ConsensusMessages,
    readonly readiness?: Pick<PtcReadiness, "beforeDuties" | "indexRequest">,
  ) {
    const prefix = `/${crypto.randomUUID()}/`;
    this.server = Deno.serve({
      hostname: "0.0.0.0",
      port: 0,
      signal: this.stop.signal,
      onListen() {},
    }, async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(prefix)) return new Response("Forbidden", { status: 403 });
      url.pathname = url.pathname.slice(prefix.length - 1);
      if (!url.pathname.startsWith("/eth/") && !url.pathname.startsWith("/lighthouse/")) {
        return new Response("Not found", { status: 404 });
      }
      const index = request.method === "GET" &&
        url.pathname.match(/^\/eth\/v1\/beacon\/states\/head\/validators\/(0x[0-9a-f]{96})$/i);
      const indexResult = index ? this.readiness?.indexRequest(index[1]) : undefined;
      const signal = AbortSignal.any([request.signal, this.stop.signal]);
      let response: Response | undefined;
      try {
        response = await messages.forward(
          new Request(url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal,
          }),
          this.upstream,
        );
        if (indexResult && index) {
          const valid = response.status !== 200 ||
            await response.clone().json().then((body) => validIndex(body, index[1])).catch(() =>
              false
            );
          indexResult(valid ? response.status : 0);
        }
        if (
          request.method === "POST" && /^\/eth\/v1\/validator\/duties\/ptc\/\d+$/.test(url.pathname)
        ) {
          await this.readiness?.beforeDuties(signal);
        }
        return response;
      } catch (error) {
        if (!response) indexResult?.(0);
        await response?.body?.cancel().catch(() => {});
        return new Response(String(error), { status: 503 });
      }
    });
    this.url = `http://host.docker.internal:${this.server.addr.port}${prefix}`;
  }

  async close(): Promise<void> {
    this.stop.abort();
    await this.server.finished;
  }
}
