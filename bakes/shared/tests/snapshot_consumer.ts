import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Devnet } from "../../../src/api.ts";
import { deadline, delay } from "../../../src/http.ts";
import type { ConsumerDatabase } from "./snapshot_consumer_process.ts";

/** External fixture ownership: stop first, then reset its disposable database, then replay. */
export class SnapshotConsumer {
  readonly database: string;
  private process?: Deno.ChildProcess;
  private exited?: Deno.CommandStatus;
  private errors?: Promise<string>;
  constructor(readonly net: Devnet, readonly directory: string) {
    this.database = resolve(directory, "consumer.json");
  }
  async start(): Promise<void> {
    if (this.process) throw new Error("Consumer already started");
    await Deno.mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.exited = undefined;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config=deno.json",
        fileURLToPath(new URL("./snapshot_consumer_process.ts", import.meta.url)),
        this.net.url,
        this.net.beaconUrl,
        this.database,
      ],
      stdout: "null",
      stderr: "piped",
    }).spawn();
    this.process = child;
    this.errors = new Response(child.stderr).text();
    void child.status.then((status) => this.exited = status);
  }
  async read(): Promise<ConsumerDatabase> {
    return JSON.parse(await Deno.readTextFile(this.database));
  }
  async waitFor(
    expected: { el: { number: string; hash: string }; slot: number },
  ): Promise<ConsumerDatabase> {
    const end = performance.now() + 60_000;
    while (performance.now() < end) {
      if (this.exited) {
        throw new Error(`Consumer exited (${this.exited.code}): ${await this.errors}`);
      }
      const data = await this.read().catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
      if (
        data && data.cursor.execution === Number(BigInt(expected.el.number)) &&
        data.execution.at(-1)?.hash === expected.el.hash && data.cursor.consensus === expected.slot
      ) return data;
      await delay(100);
    }
    throw new Error("External consumer did not replay the requested EL/CL history in 60 seconds");
  }
  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    try {
      if (!this.exited) child.kill("SIGTERM");
      const status = await deadline(child.status, 10_000, "consumer graceful shutdown").catch(
        async (error) => {
          child.kill("SIGKILL");
          await child.status;
          throw error;
        },
      );
      const errors = await this.errors;
      if (errors) await Deno.writeTextFile(resolve(this.directory, "consumer.log"), errors);
      if (!status.success) throw new Error(`Consumer failed (${status.code}): ${errors}`);
    } finally {
      this.process = undefined;
    }
  }
  async reset(): Promise<void> {
    if (this.process) throw new Error("Stop the consumer before deleting its database");
    await Deno.remove(this.database);
  }
  [Symbol.asyncDispose]() {
    return this.stop();
  }
}
