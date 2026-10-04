import { Controller } from "../src/controller.ts";
import type { Bake } from "../src/profiles.ts";
import { deadline, defaultTimeoutMs } from "../src/http.ts";
import { StateStore } from "../src/storage.ts";

/** Interruption ends startup even while the Docker socket request itself is still pending. */
export async function waitForServiceDocker(
  ping: () => Promise<unknown>,
  signal: AbortSignal,
  daemonExit: Promise<{ code: number }>,
  timeoutMs = defaultTimeoutMs(),
): Promise<void> {
  if (signal.aborted) throw new Error("Docker startup interrupted");
  const interrupted = Promise.withResolvers<never>();
  let stopped: Error | undefined;
  const stop = (error: Error) => {
    stopped ??= error;
    interrupted.reject(stopped);
  };
  const abort = () => stop(new Error("Docker startup interrupted"));
  signal.addEventListener("abort", abort, { once: true });
  void daemonExit.then(
    (status) => stop(new Error(`Private Docker exited during startup: ${status.code}`)),
    (error) => stop(new Error(`Private Docker startup failed: ${error}`)),
  );
  const expiresAt = performance.now() + timeoutMs;
  try {
    while (true) {
      const ready = await deadline(
        Promise.race([ping().then(() => true, () => false), interrupted.promise]),
        Math.max(1, expiresAt - performance.now()),
        "private Docker daemon",
      );
      if (stopped) throw stopped;
      if (ready) return;
      if (performance.now() >= expiresAt) throw new Error("Timed out: private Docker daemon");
      let retry: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            retry = setTimeout(resolve, Math.min(100, expiresAt - performance.now()));
          }),
          interrupted.promise,
        ]);
      } finally {
        clearTimeout(retry);
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Each packaged service has its own private dockerd and persistent /data/panda directory. */
export async function startServiceController(
  bake: Bake,
  signal?: AbortSignal,
): Promise<Controller> {
  signal?.throwIfAborted();
  const source = Deno.env.get("PANDA_SNAPSHOT");
  if (source && !await new StateStore("service").active()) {
    return await Controller.fromSnapshot(source, "service", undefined, {
      bake: bake.tag,
      sha256: Deno.env.get("PANDA_SNAPSHOT_SHA256"),
      signal,
    });
  }
  return await Controller.start(
    { id: "service", profile: bake.profile, bake: bake.tag },
    "auto",
    signal,
  );
}

export async function stopServiceController(controller: Controller): Promise<void> {
  if (controller.lifecycle().checkpointCapable) await controller.closePreserving();
  else await controller.close(); // Historical bakes support fresh ephemeral service runs only.
}
