import { json, withWatchdog } from "./http.ts";
import type { Manifest } from "./network.ts";

/** Credentials and private VC endpoints stay on the controller host. */
async function keymanager<T>(
  manifest: Manifest,
  route: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (new URL(manifest.vc).hostname !== "127.0.0.1") {
    throw new Error("Validator keymanager must be local");
  }
  const token = (await Deno.readTextFile(
    `${manifest.directory}/validator-keys/keys/api-token.txt`,
  )).trim();
  return await json<T>(`${manifest.vc}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: withWatchdog(signal),
  });
}

export async function importValidator(
  manifest: Manifest,
  keystore: unknown,
  password: unknown,
  signal?: AbortSignal,
) {
  if (typeof keystore !== "string" || typeof password !== "string") {
    throw new Error("importValidator expects an EIP-2335 JSON string and a password string");
  }
  const key = JSON.parse(keystore);
  if (key?.version !== 4 || !/^[a-f0-9]{96}$/i.test(key?.pubkey ?? "")) {
    throw new Error("Invalid EIP-2335 keystore version or pubkey");
  }
  const result = await keymanager<{ data: { status: string }[] }>(manifest, "/eth/v1/keystores", {
    keystores: [keystore],
    passwords: [password],
  }, signal);
  if (result.data?.length !== 1 || result.data[0].status !== "imported") {
    throw new Error(`Validator import rejected: ${result.data?.[0]?.status ?? "invalid response"}`);
  }
  return null;
}

export async function exitValidator(manifest: Manifest, pubkey: unknown, signal?: AbortSignal) {
  if (typeof pubkey !== "string" || !/^0x[a-f0-9]{96}$/i.test(pubkey)) {
    throw new Error("exitValidator expects a 48-byte hex pubkey");
  }
  const signed = await keymanager<{ data: { message: unknown; signature: string } }>(
    manifest,
    `/eth/v1/validator/${pubkey}/voluntary_exit`,
    undefined,
    signal,
  );
  if (!signed.data?.message || typeof signed.data.signature !== "string") {
    throw new Error("Keymanager returned an invalid signed exit");
  }
  const response = await fetch(`${manifest.beacon}/eth/v1/beacon/pool/voluntary_exits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed.data),
    signal: withWatchdog(signal),
  });
  if (!response.ok) throw new Error(`Exit rejected: ${await response.text()}`);
  await response.body?.cancel();
  return null;
}
