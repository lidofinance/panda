import assert from "node:assert/strict";
import { keccak256, Wallet } from "ethers";
import { AdmissionLedger, pinnedGethRevision } from "../src/admission.ts";

const wallet = new Wallet(`0x${"11".repeat(32)}`);
const raw = await wallet.signTransaction({
  type: 2,
  chainId: 1337,
  nonce: 0,
  to: wallet.address,
  gasLimit: 21000,
  maxFeePerGas: 10n,
  maxPriorityFeePerGas: 1n,
});
const hash = keccak256(raw);
const request = (id?: number | string) => ({
  jsonrpc: "2.0",
  ...(id === undefined ? {} : { id }),
  method: "eth_sendRawTransaction",
  params: [raw],
});
async function fixture(
  run: (ledger: AdmissionLedger, path: string) => Promise<void>,
  gethRevision = pinnedGethRevision,
) {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/admission.json`;
  try {
    await run(await AdmissionLedger.open(path, { gethRevision }), path);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("intent exists on disk before forwarding and successful hash is persisted before ACK", async () => {
  await fixture(async (ledger, path) => {
    let forwards = 0;
    const response = await ledger.forward(JSON.stringify(request(1)), async () => {
      forwards++;
      const reopened = await AdmissionLedger.open(path, { gethRevision: pinnedGethRevision });
      assert.equal(reopened.records[0].state, "intent");
      assert.equal(reopened.records[0].hash, hash);
      return Response.json({ jsonrpc: "2.0", id: 1, result: hash });
    });
    assert.equal((await response.json()).result, hash);
    assert.equal(forwards, 1);
    const reopened = await AdmissionLedger.open(path, { gethRevision: pinnedGethRevision });
    assert.equal(reopened.records[0].state, "accepted");
    assert.throws(() => reopened.assertSettled(), /unresolved/);
  });
});

Deno.test("notifications, duplicate batch ids and lost transport responses never lose admitted work", async () => {
  await fixture(async (ledger) => {
    await ledger.forward(
      JSON.stringify([request(), request(2), request(2)]),
      () =>
        Promise.resolve(Response.json([
          { jsonrpc: "2.0", id: 2, result: hash },
          { jsonrpc: "2.0", id: 2, result: hash },
        ])),
    );
    assert.equal(ledger.records.length, 3);
    assert(ledger.records.every((r) => r.state === "ambiguous"));
    let forwards = 0;
    await assert.rejects(
      ledger.forward(JSON.stringify(request(3)), () => {
        forwards++;
        return Promise.reject(new Error("connection lost"));
      }),
      /connection lost/,
    );
    assert.equal(forwards, 1);
    assert.equal(ledger.records[3].state, "ambiguous");
  });
});

Deno.test("only proven pinned-Geth pre-admission errors are terminal; arbitrary errors remain unresolved", async () => {
  await fixture(async (ledger) => {
    const rejected = { ...request(1), params: ["0x01"] };
    await ledger.forward(
      JSON.stringify(rejected),
      () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "typed transaction too short" },
          }),
        ),
    );
    assert.equal(ledger.records[0].state, "rejected");
    await ledger.forward(
      JSON.stringify(request(2)),
      () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32000, message: "already known" },
          }),
        ),
    );
    assert.equal(ledger.records[1].state, "ambiguous");
    await ledger.forward(
      JSON.stringify(request(3)),
      () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 3,
            error: { code: -32000, message: "transaction underpriced" },
          }),
        ),
    );
    assert.equal(ledger.records[2].state, "ambiguous");
  });
});

Deno.test("invalid-signature rejection is terminal only for the exact proven pinned-Geth response", async (t) => {
  const exact = "invalid sender: invalid transaction v, r, s values";
  for (
    const { name, revision, method, message, code, terminal } of [
      { name: "raw", method: "eth_sendRawTransaction", terminal: true },
      { name: "raw-sync", method: "eth_sendRawTransactionSync", terminal: true },
      { name: "generic sender error", message: "invalid sender", terminal: false },
      { name: "unknown detail", message: `${exact}: unknown outcome`, terminal: false },
      { name: "other revision", revision: "0".repeat(40), terminal: false },
      { name: "other method", method: "eth_sendTransaction", terminal: false },
      { name: "other code", code: -32001, terminal: false },
    ]
  ) {
    await t.step(name, () =>
      fixture(async (ledger, path) => {
        await ledger.forward(
          JSON.stringify({ ...request(1), method: method ?? "eth_sendRawTransaction" }),
          () =>
            Promise.resolve(Response.json({
              jsonrpc: "2.0",
              id: 1,
              error: { code: code ?? -32000, message: message ?? exact },
            })),
        );
        const reopened = await AdmissionLedger.open(path, {
          gethRevision: revision ?? pinnedGethRevision,
        });
        assert.equal(reopened.records[0].state, terminal ? "rejected" : "ambiguous");
        if (terminal) reopened.assertSettled();
        else assert.throws(() => reopened.assertSettled(), /unresolved/);
      }, revision));
  }
});

Deno.test("canonical inclusion or consumed nonce resolves work; absent txpool and orphan receipts do not", async () => {
  await fixture(async (ledger) => {
    await ledger.forward(
      JSON.stringify(request(1)),
      () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: hash })),
    );
    let nonce = "0x0";
    let receipt: unknown = null;
    const blockHash = `0x${"22".repeat(32)}`;
    const chain = (method: string, params: unknown[]) => {
      if (method === "eth_getBlockByNumber") {
        return Promise.resolve({ number: "0x5", hash: blockHash });
      }
      if (method === "eth_getTransactionReceipt") return Promise.resolve(receipt);
      if (method === "eth_getTransactionCount") {
        assert.deepEqual(params[1], { blockHash, requireCanonical: true });
        return Promise.resolve(nonce);
      }
      throw new Error(`unexpected RPC ${method}`);
    };
    await ledger.reconcile(chain);
    assert.throws(() => ledger.assertSettled(), /unresolved/);
    receipt = { transactionHash: hash, blockNumber: "0x5", blockHash: `0x${"33".repeat(32)}` };
    await ledger.reconcile(chain);
    assert.throws(() => ledger.assertSettled(), /unresolved/);
    nonce = "0x1";
    await ledger.reconcile(chain);
    assert.equal(ledger.records[0].state, "consumed");
    ledger.assertSettled();
  });
});

Deno.test("corrupt or truncated ledger fails closed on reopen", async () => {
  await fixture(async (_ledger, path) => {
    await Deno.writeTextFile(path, '{"schema":1');
    await assert.rejects(
      AdmissionLedger.open(path, { gethRevision: pinnedGethRevision }),
      /ledger/i,
    );
  });
});

Deno.test("ledger rejects parseable disk corruption and a missing resume journal", async () => {
  await fixture(async (ledger, path) => {
    await ledger.forward(
      JSON.stringify(request(1)),
      () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: hash })),
    );
    const text = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, text.replace('"accepted"', '"rejected"'));
    await assert.rejects(
      AdmissionLedger.open(path, { gethRevision: pinnedGethRevision }),
      /ledger/i,
    );
    await Deno.remove(path);
    await assert.rejects(
      AdmissionLedger.open(path, { gethRevision: pinnedGethRevision, create: false }),
      /ledger/i,
    );
  });
});

Deno.test("disk failure prevents forwarding or ACK and permanently faults that ledger handle", async () => {
  for (const failOn of [1, 2]) {
    await fixture(async (ledger, path) => {
      const rename = Deno.rename;
      let writes = 0;
      let forwards = 0;
      Deno.rename = async (from, to) => {
        if (String(to) === path && ++writes === failOn) throw new Error("injected disk full");
        await rename(from, to);
      };
      try {
        await assert.rejects(
          ledger.forward(JSON.stringify(request(1)), () => {
            forwards++;
            return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: hash }));
          }),
          /persistence/,
        );
        assert.equal(forwards, failOn - 1);
        assert.throws(() => ledger.assertSettled(), /faulted/);
        await assert.rejects(
          ledger.forward(JSON.stringify(request(2)), () => {
            forwards++;
            throw new Error("must not forward");
          }),
          /faulted/,
        );
        assert.equal(forwards, failOn - 1);
      } finally {
        Deno.rename = rename;
      }
      const reopened = await AdmissionLedger.open(path, { gethRevision: pinnedGethRevision });
      if (failOn === 2) assert.equal(reopened.pending[0].state, "intent");
    });
  }
});

Deno.test("parallel submissions retain all durable intents, reordered batch replies pair by unique ID", async () => {
  await fixture(async (ledger, path) => {
    const wait = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    let entered = 0;
    const send = (id: number) =>
      ledger.forward(JSON.stringify(request(id)), async () => {
        if (++entered === 2) ready.resolve();
        await wait.promise;
        return Response.json({ jsonrpc: "2.0", id, result: hash });
      });
    const left = send(1);
    const right = send(2);
    await ready.promise;
    const reopened = await AdmissionLedger.open(path, { gethRevision: pinnedGethRevision });
    assert.equal(reopened.pending.length, 2);
    wait.resolve();
    await Promise.all([left, right]);
    await ledger.forward(
      JSON.stringify([request(3), { ...request(4), params: ["0x01"] }]),
      () =>
        Promise.resolve(Response.json([
          {
            jsonrpc: "2.0",
            id: 4,
            error: { code: -32000, message: "typed transaction too short" },
          },
          { jsonrpc: "2.0", id: 3, result: hash },
        ])),
    );
    assert.deepEqual(ledger.records.map((r) => r.state), [
      "accepted",
      "accepted",
      "accepted",
      "rejected",
    ]);
  });
});

Deno.test("canonical receipt resolves inclusion but a reorg during reconciliation leaves it unresolved", async () => {
  await fixture(async (ledger) => {
    await ledger.forward(
      JSON.stringify(request(1)),
      () => Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: hash })),
    );
    let reorg = true;
    let reads = 0;
    const blockHash = `0x${"22".repeat(32)}`;
    const otherHash = `0x${"33".repeat(32)}`;
    const chain = (method: string) => {
      if (method === "eth_getBlockByNumber") {
        return Promise.resolve({
          number: "0x5",
          hash: ++reads === 3 && reorg ? otherHash : blockHash,
        });
      }
      if (method === "eth_getTransactionReceipt") {
        return Promise.resolve({ transactionHash: hash, blockNumber: "0x5", blockHash });
      }
      throw new Error(`unexpected RPC ${method}`);
    };
    await assert.rejects(ledger.reconcile(chain), /head changed/);
    assert.throws(() => ledger.assertSettled(), /unresolved/);
    reorg = false;
    reads = 0;
    await ledger.reconcile(chain);
    assert.equal(ledger.records[0].state, "confirmed");
    ledger.assertSettled();
  });
});

Deno.test("unverified Geth, malformed replies and sync timeout are ambiguous", async () => {
  await fixture(async (ledger) => {
    for (
      const reply of [
        {
          jsonrpc: "2.0",
          id: 1,
          result: hash,
          error: { code: -32000, message: "typed transaction too short" },
        },
        { id: 1, error: { code: -32602, message: "invalid params" } },
      ]
    ) {
      await ledger.forward(JSON.stringify(request(1)), () => Promise.resolve(Response.json(reply)));
      assert.equal(ledger.records.at(-1)!.state, "ambiguous");
    }
    await ledger.forward(
      JSON.stringify({ ...request(2), method: "eth_sendRawTransactionSync" }),
      () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 2,
            error: {
              code: -32000,
              message:
                "The transaction was added to the transaction pool but wasn't processed in 10s",
            },
          }),
        ),
    );
    assert.equal(ledger.records.at(-1)!.state, "ambiguous");
    assert.equal(ledger.records.at(-1)!.hash, hash);
  });
  const directory = await Deno.makeTempDir();
  try {
    const ledger = await AdmissionLedger.open(`${directory}/ledger.json`, {
      gethRevision: "unverified",
    });
    await ledger.forward(
      JSON.stringify(request(1)),
      () =>
        Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "typed transaction too short" },
          }),
        ),
    );
    assert.equal(ledger.records[0].state, "ambiguous");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
