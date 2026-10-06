import { bakeTag, type ProfileName, profileName, profiles } from "./profiles.ts";
export const images = {
  geth:
    "ethereum/client-go@sha256:798b7eb1bcef6d4be7576232beea63bf291450f48b025dc8fb5c6e37840e4364",
  lighthouse:
    "sigp/lighthouse@sha256:870934e38931d1a0f6cf47ff976e246a08a4b5509b84ff585aa2233e76744aa8",
  genesis:
    "ethpandaops/ethereum-genesis-generator@sha256:683629884b35dce22e544663abd19ce5221ce65f9f0315e3971d66c67041bc1d",
} as const;
export const buildImages = {
  rust: "rust@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4",
  runtime: "debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251",
} as const;
// Public development keys only. Never fund on a public chain.
export const mnemonic = "test test test test test test test test test test test junk";
export const account = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
export const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export interface Config {
  id: string;
  profile: ProfileName;
  bake: string;
  mode: "controlled" | "baseline";
  genesisTime: number;
  validators: number;
  chainId: number;
  churnLimitQuotient: number;
  /** Gloas separates consolidation capacity from activation/exit churn. */
  consolidationChurnLimitQuotient: number;
}
export function configuration(input: Partial<Config> = {}): Config {
  const profile = profileName(input.profile ?? Deno.env.get("PANDA_PROFILE") ?? "gloas");
  const result: Config = {
    profile,
    bake: bakeTag(input.bake ?? Deno.env.get("PANDA_BAKE") ?? "default"),
    id: "local",
    mode: "controlled",
    genesisTime: 2_000_000_000,
    validators: 64,
    chainId: 1337,
    churnLimitQuotient: profiles[profile].churnLimitQuotient,
    consolidationChurnLimitQuotient: 65536,
    ...input,
  };
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(result.id)) throw new Error("Invalid devnet id");
  if (!Number.isSafeInteger(result.genesisTime * 1000) || result.genesisTime < 0) {
    throw new Error("Invalid genesis time");
  }
  if (result.mode !== "baseline" && result.mode !== "controlled") throw new Error("Invalid mode");
  if (
    !Number.isSafeInteger(result.validators) || result.validators < 64 || result.validators > 256
  ) throw new Error("Use 64–256 validators for this mainnet-preset topology");
  if (!Number.isSafeInteger(result.chainId) || result.chainId < 1) {
    throw new Error("Invalid chain ID");
  }
  if (!Number.isSafeInteger(result.churnLimitQuotient) || result.churnLimitQuotient < 1) {
    throw new Error("Invalid churn quotient");
  }
  if (
    !Number.isSafeInteger(result.consolidationChurnLimitQuotient) ||
    result.consolidationChurnLimitQuotient < 1
  ) throw new Error("Invalid consolidation churn quotient");
  return result;
}
