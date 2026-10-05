import { Interface, Wallet } from "ethers";
import { type Devnet } from "../../../src/api.ts";
import { account, mnemonic, privateKey } from "../../../src/config.ts";
import { Infrastructure } from "../../../src/docker.ts";
import { deadline, json } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";

export async function send(net: Devnet, to: string, data: string, value: bigint): Promise<string> {
  const receiptTimeout = (await net.status()).profile === "gloas" ? 900_000 : 90_000;
  const nonce = Number(
    BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "latest"])),
  );
  const signed = await new Wallet(privateKey).signTransaction({
    type: 2,
    chainId: 1337,
    nonce,
    to,
    data,
    value,
    gasLimit: 1_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const hash = await net.rpc<string>("eth_sendRawTransaction", [signed]);
  await net.waitForService("fixture receipt", async () => {
    const receipt = await net.rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (!receipt) return;
    if (receipt.status !== "0x1") throw new Error(`Fixture reverted: ${hash}`);
    return receipt;
  }, receiptTimeout);
  return hash;
}
export async function depositValidator(net: Devnet, index: number): Promise<string> {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid validator index");
  const m = await Network.manifest((await net.status()).id);
  const infra = new Infrastructure(m.config.id);
  const relative = `added-${index}`;
  const c = await infra.container("deposit-fixture", {
    Image: m.bake.images.genesis.id,
    User: `${Deno.uid()}:${Deno.gid()}`,
    Entrypoint: ["/bin/bash"],
    Env: [`MNEMONIC=${mnemonic}`, `INDEX=${index}`, `END=${index + 1}`, `OUT=/data/${relative}`],
    Cmd: [
      "-ec",
      'eth2-val-tools keystores --insecure --source-min "$INDEX" --source-max "$END" --source-mnemonic "$MNEMONIC" --out-loc "$OUT"; eth2-val-tools deposit-data --validators-mnemonic "$MNEMONIC" --withdrawals-mnemonic "$MNEMONIC" --source-min "$INDEX" --source-max "$END" --fork-version 0x10000000 --as-json-list > "$OUT/deposit.json"',
    ],
    HostConfig: { Binds: [`${m.directory}:/data`], NetworkMode: "none" },
  });
  try {
    await c.start();
    const result = await deadline(c.wait(), 60_000, "deposit fixture generation");
    if (result.StatusCode) throw new Error(await infra.logs(c));
  } finally {
    await c.remove({ force: true, v: true });
  }
  const dir = `${m.directory}/${relative}`;
  const [deposit] = JSON.parse(await Deno.readTextFile(`${dir}/deposit.json`));
  const pubkey = `0x${deposit.pubkey}`;
  const token = (await Deno.readTextFile(`${m.directory}/validator-keys/keys/api-token.txt`))
    .trim();
  const imported = await json<{ data: { status: string }[] }>(
    `${net.validatorUrl}/eth/v1/keystores`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        keystores: [await Deno.readTextFile(`${dir}/keys/${pubkey}/voting-keystore.json`)],
        passwords: [(await Deno.readTextFile(`${dir}/secrets/${pubkey}`)).trim()],
      }),
    },
  );
  if (imported.data[0]?.status !== "imported") {
    throw new Error(`Key import failed: ${JSON.stringify(imported)}`);
  }
  const abi = new Interface([
    "function deposit(bytes pubkey, bytes withdrawal_credentials, bytes signature, bytes32 deposit_data_root) payable",
  ]);
  await send(
    net,
    "0x4242424242424242424242424242424242424242",
    abi.encodeFunctionData("deposit", [
      pubkey,
      `0x${deposit.withdrawal_credentials}`,
      `0x${deposit.signature}`,
      `0x${deposit.deposit_data_root}`,
    ]),
    32n * 10n ** 18n,
  );
  return pubkey;
}
