/** Exact-client admission and managed checkpoint refusal, including a lost response. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { encodeRlp, keccak256, toBeHex, Wallet } from "ethers";
import { AdmissionLedger } from "../../../src/admission.ts";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { Controller } from "../../../src/controller.ts";
import { json, waitFor } from "../../../src/http.ts";

export async function runAdmission() {
  if (!Deno.env.has("PANDA_TIMEOUT_MS")) Deno.env.set("PANDA_TIMEOUT_MS", "60000");
  const controller = await Controller.start({ id: `admission-${crypto.randomUUID().slice(0, 8)}` });
  try {
    await using net = new Devnet(controller.serve(0));
    return await admissionCases(controller, net);
  } finally {
    await controller.close();
  }
}

/** Fault injection changes only the transport; every submission still reaches the real Geth. */
async function upstreamLostAck(controller: Controller, net: Devnet, raw: string) {
  const manifest = controller.manifest;
  const upstream = manifest.el;
  const hash = keccak256(raw);
  let forwards = 0;
  let result: unknown;
  let forwardError: unknown;
  const proxy = createServer((request, response) => {
    void (async () => {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) body += chunk;
      forwards++;
      result = await json(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      // Geth's successful response is observed here, then its connection to Panda is reset
      // before any response headers/body. Panda itself never receives the transaction hash.
      response.destroy();
    })().catch((error) => {
      forwardError = error;
      response.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    assert(address && typeof address !== "string");
    manifest.el = `http://127.0.0.1:${address.port}`;
    await assert.rejects(net.rpc("eth_sendRawTransaction", [raw]), /500/);
    assert.equal(forwardError, undefined);
    assert.equal(forwards, 1, "Panda retried a submission after losing the upstream response");
    assert.deepEqual(result, { jsonrpc: "2.0", id: 1, result: hash });
  } finally {
    manifest.el = upstream;
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
  const journalPath = `${
    controller.network.store.generationPath(manifest.generation!)
  }/admission.json`;
  const record = async () => {
    const ledger = await AdmissionLedger.open(journalPath, {
      gethRevision: manifest.bake.source.el ?? "unknown",
      create: false,
    });
    const entries = ledger.records.filter((entry) => entry.hash === hash);
    assert.equal(entries.length, 1, "lost upstream response created duplicate or missing intents");
    return entries[0];
  };
  assert.equal((await record()).state, "ambiguous");
  assert(await net.rpc("eth_getTransactionByHash", [hash]));
  assert.equal(await net.rpc("eth_getTransactionReceipt", [hash]), null);
  if ((await net.lifecycle()).checkpointCapable) {
    const before = await net.status();
    await assert.rejects(net.stop(), (error: unknown) => {
      assert.match(String(error), /EL submissions unresolved/);
      assert(String(error).includes(hash));
      return true;
    });
    assert.equal((await record()).state, "ambiguous");
    assert.equal((await net.lifecycle()).ready, true);
    assert.equal((await net.status()).now, before.now);
  }
  await net.stepSlot();
  const receipt = await waitFor(
    "upstream-lost ACK canonical receipt",
    () =>
      net.rpc<{ status: string; blockHash: string } | null>("eth_getTransactionReceipt", [hash])
        .then((value) => value ?? undefined),
    15_000,
  );
  assert.equal(receipt.status, "0x1");
  assert.equal(receipt.blockHash, (await net.status()).el.hash);
  if ((await net.lifecycle()).checkpointCapable) {
    await net.stop();
    assert.equal((await record()).state, "confirmed");
    await net.resume();
    assert.equal((await net.status()).el.hash, receipt.blockHash);
  }
  return {
    hash,
    forwarded: forwards,
    initialState: "ambiguous",
    canonicalBlock: receipt.blockHash,
  };
}

async function admissionCases(controller: Controller, net: Devnet) {
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
  const checkpointCapable = (await net.lifecycle()).checkpointCapable;
  const beforeInvalid = await pool();
  await assert.rejects(
    net.rpc("eth_sendRawTransaction", ["0x01"]),
    /transaction|rlp|decode|short|typed/i,
  );
  assert.deepEqual(await pool(), beforeInvalid, "malformed transaction changed the pool");
  const invalidSignature = encodeRlp([
    "0x",
    toBeHex(10_000_000_000n),
    "0x5208",
    account,
    "0x01",
    "0x",
    toBeHex(1337 * 2 + 35),
    "0x01",
    "0x",
  ]);
  await assert.rejects(
    net.rpc("eth_sendRawTransaction", [invalidSignature]),
    /invalid.*(?:sender|transaction v, r, s)/,
  );
  assert.deepEqual(await pool(), beforeInvalid, "invalid signature changed the pool");
  if (checkpointCapable) {
    await net.stop();
    await net.resume();
  }
  await net.stepSlot();
  const feeCapped = await signed(0, 2n, 1n);
  const feeCappedHash = await net.rpc<string>("eth_sendRawTransaction", [feeCapped]);
  assert.equal(feeCappedHash, keccak256(feeCapped));
  const afterFeeCapped = await pool();
  if (checkpointCapable) {
    const before = await net.status();
    await assert.rejects(net.stop(), /EL submissions unresolved/);
    assert.equal((await net.lifecycle()).ready, true);
    assert.equal((await net.status()).now, before.now);
  }
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
    if (checkpointCapable) {
      // The replacement's canonical receipt consumes both nonce-zero submissions. No resend.
      const head = (await net.status()).el.hash;
      await net.stop();
      await net.resume();
      assert.equal((await net.status()).el.hash, head);
    }
    const upstreamAck = await upstreamLostAck(controller, net, await signed(1));
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
    if (checkpointCapable) {
      await assert.rejects(net.stop(), (error: unknown) => {
        assert.match(String(error), /EL submissions unresolved/);
        assert(
          String(error).includes(missingFromPool[0]),
          "evicted accepted submission lost from ledger",
        );
        return true;
      });
      assert.equal((await net.lifecycle()).ready, true);
    }
    const status = await net.status();
    const evidence = {
      event: "admission-passed",
      profile: status.profile,
      bakeKey: status.bakeKey,
      invalidRejected: true,
      managedCheckpointChecks: checkpointCapable,
      feeCappedHash,
      afterFeeCapped,
      lostAckMined: hash,
      upstreamLostAck: upstreamAck,
      acceptedCount: acceptedHashes.length,
      acceptedOutsidePool: missingFromPool.length,
    };
    await Deno.mkdir(".cache/p0-p1", { recursive: true });
    await Deno.writeTextFile(
      `.cache/p0-p1/admission-${status.profile}-${status.bake}.json`,
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify(evidence));
    return evidence;
  } finally {
    abort.abort();
    release.resolve();
    await proxy.shutdown();
  }
}

if (import.meta.main) await runAdmission();
