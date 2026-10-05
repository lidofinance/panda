import assert from "node:assert/strict";
import { resolve } from "node:path";
import { toBeHex, type TransactionRequest, Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { finalizedExecutionHash } from "../../../src/consensus.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { Network } from "../../../src/network.ts";
import { sha256 } from "../../../src/profiles.ts";
import { SnapshotStore } from "../../../src/snapshots.ts";
import { StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { exportSigningHistory } from "../../shared/tests/signing_history.ts";
import { assertFullBitvector } from "../../shared/tests/warp_assertions.ts";

async function assertPayloadVotes(net: Devnet, slot: number) {
  const block = await net.beacon<{
    data: {
      message: {
        slot: string;
        parent_root: string;
        body: {
          payload_attestations: {
            aggregation_bits: string;
            data: {
              slot: string;
              beacon_block_root: string;
              payload_present: boolean;
              blob_data_available: boolean;
            };
          }[];
        };
      };
    };
  }>(`/eth/v2/beacon/blocks/${slot}`);
  const { message } = block.data;
  assert.equal(Number(message.slot), slot);
  let positions = 0n;
  for (const vote of message.body.payload_attestations) {
    assert.equal(Number(vote.data.slot), slot - 1);
    assert.equal(vote.data.beacon_block_root, message.parent_root);
    assert.equal(vote.data.payload_present, true);
    assert.equal(vote.data.blob_data_available, true);
    assert.match(vote.aggregation_bits, /^0x[0-9a-f]{128}$/);
    positions |= BigInt(vote.aggregation_bits);
  }
  assertFullBitvector(`0x${positions.toString(16)}`, 512, `PTC in block ${slot}`);
}

async function send(net: Devnet, transaction: TransactionRequest = {}) {
  const raw = await new Wallet(privateKey).signTransaction({
    type: 2,
    chainId: 1337,
    nonce: Number(BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "latest"]))),
    to: account,
    value: 1n,
    gasLimit: 21_000,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    ...transaction,
  });
  await net.setAutomine(true);
  const hash = await net.rpc<string>("eth_sendRawTransaction", [raw]);
  const receipt = await net.waitForService(
    "external snapshot transaction",
    async () =>
      await net.rpc<{ status: string; blockNumber: string; contractAddress: string | null } | null>(
        "eth_getTransactionReceipt",
        [hash],
      ) ?? undefined,
    120_000,
  );
  await net.setAutomine(false);
  assert.equal(receipt.status, "0x1");
  return { hash, receipt };
}
async function state(net: Devnet) {
  const response = await fetch(`${net.beaconUrl}/eth/v2/debug/beacon/states/head`, {
    headers: { accept: "application/octet-stream" },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200);
  return new Uint8Array(await response.arrayBuffer());
}
type Expected = {
  status: Awaited<ReturnType<Devnet["status"]>>;
  contract: string;
  storage: string;
  included: Awaited<ReturnType<typeof send>>;
  history: Awaited<ReturnType<typeof exportSigningHistory>>;
  archiveHash: string;
};
async function startFromFileOrHttps(source: string, directory: string, id: string) {
  const expected: Expected = JSON.parse(await Deno.readTextFile(`${directory}/expected.json`));
  const started = performance.now();
  const net = await Devnet.fromSnapshot(source, { id, sha256: expected.archiveHash });
  let passed = false;
  try {
    const saved = await net.status();
    assert.equal(saved.now, expected.status.now);
    assert.equal(saved.slot, expected.status.slot);
    assert.deepEqual(saved.el, expected.status.el);
    assert.equal(
      await net.rpc("eth_getStorageAt", [expected.contract, "0x0", "latest"]),
      expected.storage,
    );
    assert.deepEqual(
      await net.rpc("eth_getTransactionReceipt", [expected.included.hash]),
      expected.included.receipt,
    );
    assert.deepEqual(await state(net), await Deno.readFile(`${directory}/beacon.ssz`));
    assert.deepEqual(await exportSigningHistory(await Network.manifest(id)), expected.history);
    const next = await send(net, {
      to: expected.contract,
      value: 0n,
      data: toBeHex(99, 32),
      gasLimit: 12_000_000,
    });
    assert.equal(Number(BigInt(next.receipt.blockNumber)), saved.slot + 1);
    assert.equal(
      BigInt(await net.rpc<string>("eth_getStorageAt", [expected.contract, "0x0", "latest"])),
      99n,
    );
    await assertPayloadVotes(net, saved.slot + 1);
    // The first block contains saved votes; the next contains votes made by the restarted VC.
    await net.advanceSlots(1);
    await assertPayloadVotes(net, saved.slot + 2);
    await net.advanceUntil(
      async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 2n,
      { maxSlots: 160, timeoutMs: 240_000 },
    );
    const final = await net.status();
    const finalized = await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false]);
    assert.equal(finalized.hash, await finalizedExecutionHash(await Network.manifest(id)));
    passed = true;
    return {
      passed,
      savedSlot: saved.slot,
      finalSlot: final.slot,
      finalizedEpoch: final.finality.data.finalized.epoch,
      elapsedMs: performance.now() - started,
    };
  } finally {
    await net.close();
    assert.equal(
      (await new Infrastructure(id).docker.listContainers({
        all: true,
        filters: { label: [`${LABEL}=${id}`] },
      })).length,
      0,
    );
    if (passed) await Deno.remove(new StateStore(id).root, { recursive: true });
  }
}

export async function verifyHttpsSnapshot(directory: string, id: string) {
  directory = resolve(directory);
  const archive = `${directory}/fixture.panda-snapshot.gz`;
  let tls: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    // A separate server certificate keeps TLS verification enabled, including CA constraints.
    await Deno.writeTextFile(
      `${directory}/openssl.cnf`,
      `[req]
distinguished_name=dn
x509_extensions=ca
prompt=no
[dn]
CN=Panda fixture CA
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
[server]
subjectAltName=IP:127.0.0.1
basicConstraints=critical,CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
`,
    );
    const openssl = async (args: string[]) => {
      const result = await new Deno.Command("openssl", { args, stdout: "null", stderr: "piped" })
        .output();
      assert(result.success, new TextDecoder().decode(result.stderr));
    };
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      `${directory}/ca-key.pem`,
      "-out",
      `${directory}/cert.pem`,
      "-config",
      `${directory}/openssl.cnf`,
    ]);
    await openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${directory}/key.pem`,
      "-out",
      `${directory}/server.csr`,
      "-subj",
      "/CN=127.0.0.1",
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      `${directory}/server.csr`,
      "-CA",
      `${directory}/cert.pem`,
      "-CAkey",
      `${directory}/ca-key.pem`,
      "-CAcreateserial",
      "-days",
      "1",
      "-out",
      `${directory}/server.pem`,
      "-extfile",
      `${directory}/openssl.cnf`,
      "-extensions",
      "server",
    ]);
    let requests = 0;
    tls = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
      cert: await Deno.readTextFile(`${directory}/server.pem`),
      key: await Deno.readTextFile(`${directory}/key.pem`),
    }, async (request) => {
      requests++;
      if (new URL(request.url).pathname !== "/asset") {
        return new Response(null, { status: 302, headers: { location: "/asset" } });
      }
      return new Response((await Deno.open(archive, { read: true })).readable, {
        headers: { "content-type": "application/gzip" },
      });
    });
    const child = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        import.meta.filename!,
        "child",
        `https://127.0.0.1:${tls.addr.port}/releases/download/v1/fixture.gz`,
        directory,
        `${id}-https`,
      ],
      env: { DENO_CERT: `${directory}/cert.pem` },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    await Deno.writeTextFile(`${directory}/https-child.log`, stdout + stderr);
    assert(child.success, stdout + stderr);
    const https = JSON.parse(stdout.trim().split("\n").at(-1)!);
    assert.equal(https.event, "external-snapshot-verified");
    assert.equal(requests, 2, "expected HTTPS redirect then asset download");
    return https;
  } finally {
    await tls?.shutdown();
  }
}

if (import.meta.main) {
  if (Deno.args[0] === "child") {
    const result = await startFromFileOrHttps(Deno.args[1], Deno.args[2], Deno.args[3]);
    console.log(JSON.stringify({ event: "external-snapshot-verified", ...result }));
  } else {
    const id = `external-${crypto.randomUUID().slice(0, 8)}`;
    const directory = resolve(`.cache/external-snapshots/${id}`);
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const started = performance.now();
    let net: Devnet | undefined;
    let passed = false;
    try {
      net = await Devnet.start({ id, profile: "gloas" });
      const deploy = await send(net, {
        to: null,
        value: 0n,
        gasLimit: 12_000_000,
        data: "0x6007600c60003960076000f360003560005500",
      });
      assert(deploy.receipt.contractAddress);
      const contract = deploy.receipt.contractAddress;
      const included = await send(net, {
        to: contract,
        value: 0n,
        data: toBeHex(42, 32),
        gasLimit: 12_000_000,
      });
      await net.advanceSlots(1);
      const status = await net.status();
      const storage = await net.rpc<string>("eth_getStorageAt", [contract, "0x0", "latest"]);
      const history = await exportSigningHistory(await Network.manifest(id));
      await Deno.writeFile(`${directory}/beacon.ssz`, await state(net));
      const snapshot = await net.createSnapshot();
      // Continue immediately: archive IO must not give VC startup time to hide a race.
      const resumed = await send(net, {
        to: contract,
        value: 0n,
        data: toBeHex(77, 32),
        gasLimit: 12_000_000,
      });
      assert.equal(Number(BigInt(resumed.receipt.blockNumber)), status.slot + 1);
      await assertPayloadVotes(net, status.slot + 1);
      await net.advanceSlots(1);
      await assertPayloadVotes(net, status.slot + 2);
      const archive = `${directory}/fixture.panda-snapshot.gz`;
      const exported = await net.exportSnapshot(snapshot, archive);
      const original = await new SnapshotStore(new StateStore(id), new Infrastructure(id)).read(
        snapshot.id,
      );
      const expected: Expected = {
        status,
        contract,
        storage,
        included,
        history,
        archiveHash: exported.sha256,
      };
      await Deno.writeTextFile(`${directory}/expected.json`, JSON.stringify(expected));
      await assert.rejects(Devnet.fromSnapshot(archive, { id }), /without active state/);
      await net.close();
      net = undefined;
      const local = await startFromFileOrHttps(archive, directory, `${id}-file`);

      const https = await verifyHttpsSnapshot(directory, id);
      assert.equal(await sha256(await Deno.readFile(archive)), exported.sha256);
      assert.deepEqual(
        await new SnapshotStore(new StateStore(id), new Infrastructure(id)).read(snapshot.id),
        original,
      );
      await profileReport(status, "snapshot-external", {
        passed: true,
        local,
        https,
        archiveBytes: exported.bytes,
        archiveSha256: exported.sha256,
        elapsedMs: performance.now() - started,
      });
      passed = true;
    } finally {
      await net?.close();
      if (passed) await Deno.remove(new StateStore(id).root, { recursive: true });
    }
  }
}
