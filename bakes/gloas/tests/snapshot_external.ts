/** Local-file and verified HTTPS startup use the same exported snapshot bytes. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { toBeHex } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { Controller } from "../../../src/controller.ts";
import { finalizedExecutionHash } from "../../../src/consensus.ts";
import { Infrastructure, LABEL } from "../../../src/docker.ts";
import { sha256 } from "../../../src/profiles.ts";
import { StateStore } from "../../../src/storage.ts";
import { profileReport } from "../../shared/tests/report.ts";
import { assertSnapshotPtc, snapshotBeaconState, snapshotTransaction } from "./snapshots.ts";

type Expected = {
  status: Awaited<ReturnType<Devnet["status"]>>;
  contract: string;
  included: Awaited<ReturnType<typeof snapshotTransaction>>;
  archiveHash: string;
};

async function verifyImport(source: string, directory: string, id: string, retain: boolean) {
  const expected: Expected = JSON.parse(await Deno.readTextFile(`${directory}/expected.json`));
  const started = performance.now();
  let controller: Controller | undefined;
  let passed = false;
  try {
    controller = await Controller.fromSnapshot(source, { id }, { sha256: expected.archiveHash });
    let net = new Devnet(controller.serve(0));
    const saved = await net.status();
    assert.equal(saved.now, expected.status.now);
    assert.equal(saved.slot, expected.status.slot);
    assert.deepEqual(saved.el, expected.status.el);
    assert.equal(saved.automine, false);
    assert.deepEqual(
      await snapshotBeaconState(net.url),
      await Deno.readFile(`${directory}/beacon.ssz`),
    );
    assert.deepEqual(
      await net.rpc("eth_getTransactionReceipt", [expected.included.hash]),
      expected.included.receipt,
    );
    assert.equal(
      BigInt(await net.rpc<string>("eth_getStorageAt", [expected.contract, "0x0", "latest"])),
      42n,
    );
    const next = await snapshotTransaction(net, {
      to: expected.contract,
      value: 0n,
      data: toBeHex(99, 32),
      gasLimit: 12_000_000,
    });
    assert.equal(Number(BigInt(next.receipt.blockNumber)), Number(BigInt(saved.el.number)) + 1);
    await assertSnapshotPtc(net, saved.slot + 1);
    await net.advanceSlots(1);
    await assertSnapshotPtc(net, saved.slot + 2);
    if (retain) {
      const retained = await net.status();
      await controller.closePreserving();
      controller = undefined;
      // No network access should be attempted for the initial seed once active data exists.
      controller = await Controller.fromSnapshot("https://invalid.invalid/no-longer-available", {
        id,
      });
      net = new Devnet(controller.serve(0));
      const resumed = await net.status();
      assert.equal(resumed.now, retained.now);
      assert.equal(resumed.el.hash, retained.el.hash);
      assert.equal(
        BigInt(await net.rpc<string>("eth_getStorageAt", [expected.contract, "0x0", "latest"])),
        99n,
      );
      await net.stepSlot();
    } else {
      await net.advanceUntil(
        async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 2n,
        { maxSlots: 160, timeoutMs: 240_000 },
      );
      const finalized = await net.rpc<{ hash: string }>("eth_getBlockByNumber", [
        "finalized",
        false,
      ]);
      assert.equal(finalized.hash, await finalizedExecutionHash(controller.manifest));
    }
    passed = true;
    return {
      passed,
      savedSlot: saved.slot,
      finalSlot: (await net.status()).slot,
      retainedSeedPrecedence: retain,
      elapsedMs: performance.now() - started,
    };
  } finally {
    await controller?.close();
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

async function verifyHttps(directory: string, id: string) {
  await Deno.writeTextFile(
    `${directory}/openssl.cnf`,
    `[req]
distinguished_name=dn
x509_extensions=ca
prompt=no
[dn]
CN=Panda snapshot fixture CA
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
    `${directory}/ca.pem`,
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
    `${directory}/ca.pem`,
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
  const server = Deno.serve({
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
    return new Response((await Deno.open(`${directory}/fixture.gz`, { read: true })).readable, {
      headers: { "content-type": "application/gzip" },
    });
  });
  try {
    const child = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        import.meta.filename!,
        "child",
        `https://127.0.0.1:${server.addr.port}/release`,
        directory,
        id,
      ],
      env: { DENO_CERT: `${directory}/ca.pem` },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    await Deno.writeTextFile(`${directory}/https-child.log`, stdout + stderr);
    assert(child.success, stdout + stderr);
    assert.equal(requests, 2, "expected HTTPS redirect and asset requests");
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally {
    await server.shutdown();
  }
}

if (import.meta.main) {
  if (Deno.args[0] === "child") {
    console.log(
      JSON.stringify(await verifyImport(Deno.args[1], Deno.args[2], Deno.args[3], false)),
    );
  } else {
    const id = `external-${crypto.randomUUID().slice(0, 8)}`;
    const directory = resolve(`.cache/external-snapshots/${id}`);
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const started = performance.now();
    let net: Devnet | undefined;
    let passed = false;
    try {
      net = await Devnet.start({ id, profile: "gloas" });
      const deployment = await snapshotTransaction(net, {
        to: null,
        value: 0n,
        gasLimit: 12_000_000,
        data: "0x6007600c60003960076000f360003560005500",
      });
      const contract = deployment.receipt.contractAddress;
      assert(contract);
      const included = await snapshotTransaction(net, {
        to: contract,
        value: 0n,
        data: toBeHex(42, 32),
        gasLimit: 12_000_000,
      });
      await net.advanceSlots(1);
      const status = await net.status();
      await Deno.writeFile(`${directory}/beacon.ssz`, await snapshotBeaconState(net.url));
      const snapshot = await net.createSnapshot();
      const exported = await net.exportSnapshot(snapshot, `${directory}/fixture.gz`);
      const expected: Expected = { status, contract, included, archiveHash: exported.sha256 };
      await Deno.writeTextFile(`${directory}/expected.json`, JSON.stringify(expected));
      await net.close();
      net = undefined;
      const local = await verifyImport(exported.path, directory, `${id}-file`, true);
      const https = await verifyHttps(directory, `${id}-https`);
      assert.equal(await sha256(await Deno.readFile(exported.path)), exported.sha256);
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
