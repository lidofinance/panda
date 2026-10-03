/** Characterize exact EL admission, including a lost response. No snapshot API is simulated. */
import assert from "node:assert/strict";
import { keccak256, Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { json, waitFor } from "../../../src/http.ts";

if (!Deno.env.has("PANDA_TIMEOUT_MS")) Deno.env.set("PANDA_TIMEOUT_MS", "60000");
await using net = await Devnet.start({ id: `admission-${crypto.randomUUID().slice(0, 8)}` });
await net.stepSlot();
const wallet = new Wallet(privateKey);
const signed = (nonce: number, fee = 10_000_000_000n, tip = 1_000_000_000n) =>
  wallet.signTransaction({
    type: 2,
    chainId: 1337,
    nonce,
    to: account,
    value: 1n,
    gasLimit: 21000,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: tip,
  });
const pool = () => net.rpc("txpool_content");
const beforeInvalid = await pool();
await assert.rejects(
  net.rpc("eth_sendRawTransaction", ["0x01"]),
  /transaction|rlp|decode|short|typed/i,
);
assert.deepEqual(await pool(), beforeInvalid, "malformed transaction changed the pool");
const feeCapped = await signed(0, 2n, 1n);
const feeCappedHash = await net.rpc<string>("eth_sendRawTransaction", [feeCapped]);
assert.equal(feeCappedHash, keccak256(feeCapped));
const afterFeeCapped = await pool();
await waitFor(
  "indexed EL reports no receipt for the fee-capped transaction",
  async () =>
    await net.rpc("eth_getTransactionReceipt", [feeCappedHash]) === null ? true : undefined,
  15_000,
);
const raw = await signed(0);
const hash = keccak256(raw);
const accepted = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let upstreamResult: unknown;
// The real Panda/Geth receives and accepts the transaction. Only delivery of its ACK is interrupted.
const proxy = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
  try {
    const body = await request.text();
    upstreamResult = await json(net.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    accepted.resolve();
    await release.promise;
    return Response.json(upstreamResult);
  } catch (error) {
    accepted.reject(error);
    throw error;
  }
});
const abort = new AbortController();
try {
  const outcome = fetch(`http://127.0.0.1:${proxy.addr.port}`, {
    method: "POST",
    signal: abort.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [raw],
    }),
  });
  const failed = assert.rejects(
    outcome,
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  await accepted.promise;
  assert.deepEqual(upstreamResult, { jsonrpc: "2.0", id: 1, result: hash });
  abort.abort();
  await failed;
  release.resolve();
  await waitFor(
    "accepted transaction visible despite lost response",
    async () => (await net.rpc("eth_getTransactionByHash", [hash])) ? true : undefined,
    15_000,
  );
  // No automatic resend: one ordinary block must execute the already admitted transaction.
  await net.stepSlot();
  const receipt = await waitFor(
    "lost-ACK transaction receipt",
    async () =>
      (await net.rpc<{ status: string; transactionHash: string } | null>(
        "eth_getTransactionReceipt",
        [hash],
      )) ?? undefined,
    15_000,
  );
  assert.equal(receipt?.status, "0x1");
  assert.equal(receipt.transactionHash, hash);
  // More queued transactions than the default per-account limit: a successful hash response
  // does not promise that every accepted transaction remains visible in txpool_content.
  const acceptedHashes: string[] = [];
  for (let nonce = 100; nonce < 180; nonce++) {
    const tx = await signed(nonce);
    const acceptedHash = await net.rpc<string>("eth_sendRawTransaction", [tx]);
    assert.equal(acceptedHash, keccak256(tx));
    acceptedHashes.push(acceptedHash);
  }
  const missingFromPool = await waitFor(
    "accepted transactions outside the visible pool",
    async () => {
      const visible = JSON.stringify(await pool());
      const missing = acceptedHashes.filter((acceptedHash) => !visible.includes(acceptedHash));
      return missing.length ? missing : undefined;
    },
    15_000,
  );
  for (const acceptedHash of missingFromPool) {
    assert.equal(await net.rpc("eth_getTransactionByHash", [acceptedHash]), null);
    assert.equal(await net.rpc("eth_getTransactionReceipt", [acceptedHash]), null);
  }
  const status = await net.status();
  const evidence = {
    event: "admission-passed",
    profile: status.profile,
    bakeKey: status.bakeKey,
    invalidRejected: true,
    feeCappedHash,
    afterFeeCapped,
    lostAckMined: hash,
    acceptedCount: acceptedHashes.length,
    acceptedOutsidePool: missingFromPool.length,
  };
  await Deno.mkdir(".cache/p0-p1", { recursive: true });
  await Deno.writeTextFile(
    `.cache/p0-p1/admission-${status.profile}-${status.bake}.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  abort.abort();
  release.resolve();
  await proxy.shutdown();
}
