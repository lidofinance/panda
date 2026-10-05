import type { Config } from "./config.ts";
import { Controller } from "./controller.ts";
import { defaultTimeoutMs } from "./http.ts";
import { operationId, PandaClient, type SnapshotOptions, type SnapshotRef } from "./client.ts";
import {
  saveSnapshotStream,
  type SnapshotExportResult,
  type SnapshotImportOptions,
} from "./snapshot_archive.ts";
export * from "./client.ts";
export type { SnapshotExportResult, SnapshotImportOptions } from "./snapshot_archive.ts";
export interface SnapshotStartOptions extends SnapshotOptions, SnapshotImportOptions {
  id: string;
}
/** Internal Deno adapter for local startup, filesystem export and owned cleanup. */
export class Devnet extends PandaClient {
  private controller?: Controller;
  private closing?: Promise<void>;
  constructor(url: string) {
    super(url, { timeoutMs: defaultTimeoutMs() });
  }
  static async start(config: Partial<Config> = {}): Promise<Devnet> {
    return await Devnet.owned(config, "new");
  }
  /** Open an existing verified checkpoint; never initialize fresh genesis as a fallback. */
  static async open(config: Partial<Config> = {}): Promise<Devnet> {
    return await Devnet.owned(config, "resume");
  }
  static async fromSnapshot(
    snapshot: SnapshotRef | string,
    options: SnapshotStartOptions,
  ): Promise<Devnet> {
    const controller = await Controller.fromSnapshot(
      typeof snapshot === "string" ? snapshot : snapshot.id,
      options.id,
      operationId(options.operationId ?? crypto.randomUUID()),
      options,
    );
    return await Devnet.attachOwned(controller, true);
  }
  private static async owned(config: Partial<Config>, mode: "new" | "resume"): Promise<Devnet> {
    const controller = await Controller.start(config, mode);
    return await Devnet.attachOwned(controller, mode === "resume");
  }
  private static async attachOwned(
    controller: Controller,
    preserveOnFailure: boolean,
  ): Promise<Devnet> {
    try {
      const api = new Devnet(controller.serve(0));
      api.controller = controller;
      return api;
    } catch (error) {
      if (preserveOnFailure) await controller.closePreserving();
      else await controller.close();
      throw error;
    }
  }
  /** Save the HTTP archive to a file on this caller's machine. */
  async exportSnapshot(
    snapshot: SnapshotRef | string,
    path: string,
  ): Promise<SnapshotExportResult> {
    const response = await this.downloadSnapshot(snapshot);
    return await saveSnapshotStream(response.body!, path, {
      sha256: response.headers.get("x-panda-sha256") ?? undefined,
      signal: this.disconnected.signal,
    });
  }
  override close(): Promise<void> {
    return this.closing ??= (async () => {
      await super.close();
      await this.controller?.close();
    })();
  }
}
